"""把明确标注的静态分肢或简化蒙皮拟合到 Medium 身体，并离线生成肘膝链权重。"""
import math


# 所有部位来自每个源模型的标注，不按人物名称或颜色猜身体结构。
def bind_parts(bpy, bmesh, rig, imported, spec, canonical_parts):
    from mathutils import Matrix, Vector
    source_objects = {obj.name:obj for obj in imported if obj.type == 'MESH'}
    roles = {'head':spec['head_nodes'],'torso':spec['body_nodes'],'left_arm':spec.get('left_arm_nodes',[]),'right_arm':spec.get('right_arm_nodes',[]),'left_leg':spec.get('left_leg_nodes',[]),'right_leg':spec.get('right_leg_nodes',[])}
    group_roles=spec.get('part_vertex_groups',{})

    # 只抽取由源骨骼分组证明属于某个部位的真实面。
    def copy_role(obj, name, group_names=None):
        part=obj.copy()
        part.data=obj.data.copy()
        part.name=name
        bpy.context.collection.objects.link(part)
        if group_names:
            ids={group.index for group in part.vertex_groups if group.name in group_names}
            selected={vertex.index for vertex in part.data.vertices if sum(group.weight for group in vertex.groups if group.group in ids)>.5}
            mesh=bmesh.new()
            mesh.from_mesh(part.data)
            mesh.verts.ensure_lookup_table()
            bmesh.ops.delete(mesh,geom=[face for face in mesh.faces if sum(vertex.index in selected for vertex in face.verts)/len(face.verts)<.5],context='FACES')
            bmesh.ops.delete(mesh,geom=[vertex for vertex in mesh.verts if not vertex.link_faces],context='VERTS')
            mesh.to_mesh(part.data)
            mesh.free()
        world=part.matrix_world.copy()
        part.parent=None
        part.parent_type='OBJECT'
        part.matrix_world=Matrix.Identity(4)
        part.data.transform(world)
        part.modifiers.clear()
        part.vertex_groups.clear()
        return part

    # 取得源部位或标准部位的实际几何范围。
    def box(parts, side=0):
        points=[obj.matrix_world @ vertex.co for obj in parts for vertex in obj.data.vertices if not side or vertex.co.x*side>0]
        if not points:
            raise ValueError('empty anatomical source group')
        return [(min(point[i] for point in points),max(point[i] for point in points)) for i in range(3)]

    prepared={}
    all_body=list(dict.fromkeys(spec['body_nodes']+spec.get('head_nodes',[])))
    for role,names in roles.items():
        if role in group_roles:
            candidate_names=all_body
            prepared[role]=[copy_role(source_objects[name],'_fit_'+role+'_'+str(index),group_roles[role]) for index,name in enumerate(candidate_names)]
        else:
            prepared[role]=[copy_role(source_objects[name],'_fit_'+role+'_'+str(index)) for index,name in enumerate(names)]
        prepared[role]=[obj for obj in prepared[role] if obj.data.polygons]
    if not prepared['head'] or not prepared['torso']:
        raise ValueError('source has no marked face or torso geometry')
    target_head=box([canonical_parts['body_head'],canonical_parts['body_scalp']] if spec.get('partition_scalp') else [canonical_parts['body_head']])
    target_arms={side:box([canonical_parts['body_arms'],canonical_parts['body_hands']],side) for side in [1,-1]}
    target_legs={side:box([canonical_parts['body_legs'],canonical_parts['body_feet']],side) for side in [1,-1]}
    target_torso=[(-.32,.32),(-.24,.24),(.60,1.32)]
    source_boxes={role:box(objects) for role,objects in prepared.items() if objects}

    # 坐标逐部位映射到标准长度和关节位置，源方盒或脸型拓扑仍保留。
    def fit_point(point, source_box, target_box, arm_side=0):
        axes=[0,1,2]
        signs=[1,1,1]
        if arm_side and source_box[2][1]-source_box[2][0]>(source_box[0][1]-source_box[0][0])*1.3:
            axes=[2,1,0]
            signs=[-arm_side,1,arm_side]
        result=Vector((0,0,0))
        for target_axis,source_axis in enumerate(axes):
            lo,hi=source_box[source_axis]
            amount=(point[source_axis]-lo)/(hi-lo) if hi-lo>.000001 else .5
            if signs[target_axis]<0:
                amount=1-amount
            a,b=target_box[target_axis]
            result[target_axis]=a+(b-a)*amount
        return result

    # 标准骨架链按关节位置插值，腕和踝切面两侧使用相同权重。
    def weights(point, role):
        if role=='head':
            return [('head',1)]
        if role.endswith('arm'):
            suffix='.l' if role.startswith('left') else '.r'
            names=['upperarm'+suffix,'lowerarm'+suffix,'wrist'+suffix,'hand'+suffix]
            axis=0
            sign=1 if suffix=='.l' else -1
        elif role.endswith('leg'):
            suffix='.l' if role.startswith('left') else '.r'
            names=['upperleg'+suffix,'lowerleg'+suffix,'foot'+suffix,'toes'+suffix]
            axis=2
            sign=-1
        else:
            names=['hips','spine','chest']
            axis=2
            sign=1
        values=[rig.data.bones[name].head_local[axis]*sign for name in names]
        value=point[axis]*sign
        if value<=values[0]:
            return [(names[0],1)]
        for index in range(len(names)-1):
            if value<=values[index+1]:
                amount=(value-values[index])/max(values[index+1]-values[index],.000001)
                return [(names[index],1-amount),(names[index+1],amount)]
        return [(names[-1],1)]

    # 将拟合后的顶点和权重写入最终标准骨架，不依赖浏览器运行时重定向。
    def bind_object(obj,role,source_box,target_box,arm_side=0):
        for vertex in obj.data.vertices:
            vertex.co=fit_point(vertex.co,source_box,target_box,arm_side)
        obj.parent=rig
        obj.matrix_parent_inverse=Matrix.Identity(4)
        obj.matrix_basis=Matrix.Identity(4)
        groups={bone.name:obj.vertex_groups.new(name=bone.name) for bone in rig.data.bones}
        for vertex in obj.data.vertices:
            for name,weight in weights(vertex.co,role):
                if weight>0:
                    groups[name].add([vertex.index],weight,'REPLACE')
        obj.modifiers.new(name='StandardRig',type='ARMATURE').object=rig

    for role,objects in prepared.items():
        if not objects:
            continue
        side=1 if role.startswith('left') else -1
        target=target_head if role=='head' else target_torso if role=='torso' else target_arms[side] if role.endswith('arm') else target_legs[side]
        for obj in objects:
            bind_object(obj,role,source_boxes[role],target,side if role.endswith('arm') else 0)
    hair=[copy_role(source_objects[name],'_fit_hair_'+str(index)) for index,name in enumerate(spec.get('hair_nodes',[]))]
    for obj in hair:
        bind_object(obj,'head',source_boxes['head'],target_head)
    upper=[copy_role(source_objects[name],'_fit_cape_'+str(index)) for index,name in enumerate(spec.get('upper_nodes',[]))]
    for obj in upper:
        bind_object(obj,'torso',source_boxes['torso'],target_torso)
    updated=dict(spec)
    for role,field in [('head','head_nodes'),('torso','body_nodes'),('left_arm','left_arm_nodes'),('right_arm','right_arm_nodes'),('left_leg','left_leg_nodes'),('right_leg','right_leg_nodes')]:
        updated[field]=[obj.name for obj in prepared[role]]
    if spec.get('scalp_source_nodes') and 'head' not in group_roles:
        head_names={name:obj.name for name,obj in zip(spec['head_nodes'],prepared['head'])}
        updated['scalp_source_nodes']=[head_names[name] for name in spec['scalp_source_nodes']]
    updated['hair_nodes']=[obj.name for obj in hair]
    updated['upper_nodes']=[obj.name for obj in upper]
    parts={obj.name:obj for objects in prepared.values() for obj in objects}
    parts.update({obj.name:obj for obj in hair+upper})
    return parts,updated,{'method':'anatomical-part fitting to canonical segment bounds and interpolated canonical-chain skin weights','source_bounds':source_boxes,'target_head_bounds':target_head,'target_torso_bounds':target_torso,'has_source_legs':bool(prepared['left_leg'] and prepared['right_leg'])}
