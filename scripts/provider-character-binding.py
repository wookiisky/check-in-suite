"""把明确标注的静态分肢或简化蒙皮拟合到 Medium 身体，并离线生成肘膝链权重。"""
import math
import importlib.util
from pathlib import Path

_clothing_spec = importlib.util.spec_from_file_location('provider_clothing_components', Path(__file__).with_name('provider-character-clothing-components.py'))
CLOTHING_COMPONENTS = importlib.util.module_from_spec(_clothing_spec)
_clothing_spec.loader.exec_module(CLOTHING_COMPONENTS)


# 腰带按真实腰部逐截面外移，同一射线保留壳厚，不把胸部宽度带入腰部。
def fit_waist_clothing(jobs, canonical_parts, clearance, reference=None):
    import hashlib
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    if not jobs:
        return []
    body_objects = [canonical_parts[name] for name in ['body_torso', 'body_legs']]
    added = set()
    if reference:
        path = Path(__file__).resolve().parents[1]/reference['path']
        if hashlib.sha256(path.read_bytes()).hexdigest() != reference['sha256']:
            raise ValueError('waist body reference checksum mismatch: ' + str(path))
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path))
        added = set(bpy.data.objects)-before
        meshes = {obj.name.split('.')[0]:obj for obj in added if obj.type == 'MESH'}
        body_objects = [meshes[name] for name in ['body_torso', 'body_legs']]
    body_points, body_faces = [], []
    for obj in body_objects:
        offset = len(body_points)
        body_points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        body_faces.extend(tuple(offset + index for index in face.vertices) for face in obj.data.polygons)
    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)
    envelope = BVHTree.FromPolygons(body_points, body_faces)
    reports = []
    for obj, components in jobs:
        faces = {index for component in components for index in component['faces']}
        indices = {index for face in obj.data.polygons if face.index in faces for index in face.vertices}
        points = [vertex.co.copy() for vertex in obj.data.vertices]
        inner_surface = BVHTree.FromPolygons(points, [tuple(face.vertices) for face in obj.data.polygons if face.index in faces])
        moved, maximum_shift = 0, 0.0
        for index in indices:
            point = points[index]
            direction = Vector((point.x, point.y, 0)).normalized()
            origin = Vector((0, 0, point.z))
            body_hit = envelope.ray_cast(origin+direction*3, -direction, 6)[0]
            if body_hit is None or body_hit.dot(direction) <= 0:
                continue
            inner = inner_surface.ray_cast(origin, direction, 3)[0]
            radius = min(inner.xy.length, point.xy.length) if inner is not None else point.xy.length
            shift = max(0, body_hit.xy.length+clearance-radius)
            if shift:
                obj.data.vertices[index].co = point+direction*shift
                moved += 1
                maximum_shift = max(maximum_shift, shift)
        reports.append({'node': obj.name, 'vertices': len(indices), 'moved_vertices': moved,
                        'maximum_shift': maximum_shift, 'clearance': clearance,
                        **({'body_reference': dict(reference)} if reference else {})})
    return reports


# 衣片沿原内表面外移到两种身体的联合包络之外，同一射线上的壳厚和衣片开口不变。
def fit_torso_clothing(bpy, bmesh, objects, canonical_parts, configuration, waist_accessory_top=None):
    import hashlib
    from pathlib import Path
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    reference = configuration['reference']
    path = Path(__file__).resolve().parents[1] / reference['path']
    if hashlib.sha256(path.read_bytes()).hexdigest() != reference['sha256']:
        raise ValueError('clothing body reference checksum mismatch: ' + str(path))
    minimum_height = configuration['minimum_height']
    body_points = [obj.matrix_world @ vertex.co for name, obj in canonical_parts.items() if name in ['body_torso', 'body_legs'] for vertex in obj.data.vertices if vertex.co.z >= minimum_height]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - before
    mesh = next(obj for obj in added if obj.type == 'MESH' and obj.name.split('.')[0] == reference['node'])
    layer = mesh.data.uv_layers.active
    left, right, bottom, top = reference['bone_uv_region']
    for face in mesh.data.polygons:
        uv = sum((layer.data[index].uv for index in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
        if not (left <= uv.x < right and bottom <= uv.y < top):
            continue
        center = sum((mesh.data.vertices[index].co for index in face.vertices), Vector((0, 0, 0))) / len(face.vertices)
        if abs(center.x) < reference['max_abs_x']:
            body_points.extend(mesh.matrix_world @ mesh.data.vertices[index].co for index in face.vertices if mesh.data.vertices[index].co.z >= minimum_height)
    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)
    hull = bmesh.new()
    for point in body_points:
        hull.verts.new(point)
    bmesh.ops.convex_hull(hull, input=list(hull.verts))
    envelope = BVHTree.FromBMesh(hull, epsilon=.000001)
    hull.free()
    points, faces, garment_vertices, waist_jobs = [], [], [], []
    for obj in objects:
        lower_components = [component for component in CLOTHING_COMPONENTS.garment_components(obj)
                            if waist_accessory_top is not None and max(point[2] for point in component['points']) <= waist_accessory_top]
        lower_faces = {index for component in lower_components for index in component['faces']}
        if lower_components:
            waist_jobs.append((obj, lower_components))
        indices = set()
        offset = len(points)
        points.extend(vertex.co.copy() for vertex in obj.data.vertices)
        for face in obj.data.polygons:
            if CLOTHING_COMPONENTS.legacy_body_face(obj, face):
                continue
            faces.append(tuple(offset + index for index in face.vertices))
            # lower仍参与旧upper内表面采样，但不接受upper外移，避免共享射线改变既有上装。
            if face.index not in lower_faces:
                indices.update(face.vertices)
        garment_vertices.extend((obj, index) for index in indices)
    waist_clearance = configuration.get('waist_clearance', configuration['clearance'])
    waist_reports = fit_waist_clothing(waist_jobs, canonical_parts, waist_clearance, configuration.get('waist_reference'))
    inner_surface = BVHTree.FromPolygons(points, faces, epsilon=.000001) if faces else None
    moved = 0
    for obj, index in garment_vertices:
        point = obj.data.vertices[index].co
        if point.z < minimum_height or point.xy.length < .000001:
            continue
        direction = Vector((point.x, point.y, 0)).normalized()
        target = envelope.ray_cast(Vector((direction.x * 3, direction.y * 3, point.z)), -direction, 6)[0]
        if target is None or target.dot(direction) <= 0:
            continue
        inner = inner_surface.ray_cast(Vector((0, 0, point.z)), direction, 3)[0]
        radius = min(inner.xy.length, point.xy.length) if inner is not None else point.xy.length
        shift = max(0, target.xy.length + configuration['clearance'] - radius)
        if shift:
            point.x += direction.x * shift
            point.y += direction.y * shift
            moved += 1
    return {'moved_vertices': moved, 'clearance': configuration['clearance'], 'reference_sha256': reference['sha256'],
            'waist_clothing_fit': waist_reports,
            'method': 'Upper garments use the torso envelope; declared whole waist garments use actual local waist sections. Topology, height, UV and weights retained.'}


# 真实裸拳只提供手部截面中心与大小，原拳套的形状仍来自原包。
def rigid_hand_reference(bpy, declaration):
    import hashlib
    from pathlib import Path
    from mathutils import Vector

    path = Path(__file__).resolve().parents[1] / declaration['path']
    if hashlib.sha256(path.read_bytes()).hexdigest() != declaration['sha256']:
        raise ValueError('刚性手部参照校验值不符')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - before
    try:
        obj = next(obj for obj in added if obj.type == 'MESH' and obj.name.split('.')[0] == declaration['node'])
        layer = obj.data.uv_layers.active
        selected = set()
        for face in obj.data.polygons:
            uv = sum((layer.data[loop].uv for loop in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
            if any(left <= uv.x < right and bottom <= uv.y < top for left, right, bottom, top in declaration['uv_regions']):
                selected.update(face.vertices)
        points = [obj.matrix_world @ obj.data.vertices[index].co for index in selected]
        result = {}
        for sign in [-1, 1]:
            side = [point for point in points if point.x * sign > 0]
            bounds = [(min(point[axis] for point in side), max(point[axis] for point in side)) for axis in range(3)]
            result[sign] = {'center': Vector(tuple((low + high) / 2 for low, high in bounds)), 'bounds': bounds}
        return result
    finally:
        for obj in added:
            bpy.data.objects.remove(obj, do_unlink=True)


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
        part.animation_data_clear()
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
        if spec.get('source_forward_axis') == '+Y':
            world = Matrix.Diagonal((-1, -1, 1, 1)) @ world
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
    if spec.get('head_adapter') and spec.get('head_envelope_method') != 'canonical-scalp-envelope':
        # 自然脸壳的深度来自头皮，鼻尖只作为最终总边界，不能把整张脸推到鼻尖深度。
        target_head[1] = box([canonical_parts['body_scalp']])[1]
    target_arms={side:box([canonical_parts['body_arms'],canonical_parts['body_hands']],side) for side in [1,-1]}
    if spec.get('torso_clothing_fit'):
        # 手臂从标准躯干外缘开始，不能把环绕胸前的参考顶点当成肩部内端。
        shoulder = max(abs(vertex.co.x) for vertex in canonical_parts['body_torso'].data.vertices)
        target_arms[1][0] = (shoulder, target_arms[1][0][1])
        target_arms[-1][0] = (target_arms[-1][0][0], -shoulder)
    target_legs={side:box([canonical_parts['body_legs'],canonical_parts['body_feet']],side) for side in [1,-1]}
    target_torso=[(-.32,.32),(-.24,.24),(.60,1.32)]
    source_boxes={role:box(objects) for role,objects in prepared.items() if objects}
    landmarks = spec.get('head_landmark_bounds_blender')
    if landmarks:
        source_boxes['head'] = [list(pair) for pair in landmarks]
        if spec.get('source_forward_axis') == '+Y':
            source_boxes['head'][:2] = [[-high, -low] for low, high in source_boxes['head'][:2]]

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

    waist_fit = None
    if spec.get('torso_waist_fit') == 'leg-top-landmark':
        # 躯干包含低于腿顶的胯部，保留接触高度，不能把它当作一个长方体独立拉伸。
        source_height = max(source_boxes[role][2][1] for role in ['left_leg', 'right_leg'])
        target_height = max(bounds[2][1] for bounds in target_legs.values())
        waist_fit = {'source_height': source_height, 'target_height': target_height}

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

    rigid_declaration = spec.get('rigid_hand_clothing')
    rigid_reference = rigid_hand_reference(bpy, rigid_declaration['reference']) if rigid_declaration else None
    rigid_evidence = []

    # 将拟合后的顶点和权重写入最终标准骨架，不依赖浏览器运行时重定向。
    def bind_object(obj,role,source_box,target_box,arm_side=0):
        original_points = [vertex.co.copy() for vertex in obj.data.vertices] if rigid_declaration and role.endswith('arm') else None
        for vertex in obj.data.vertices:
            source_height = vertex.co.z
            vertex.co=fit_point(vertex.co,source_box,target_box,arm_side)
            if role == 'torso' and waist_fit:
                source_low, source_high = source_box[2]
                target_low, target_high = target_box[2]
                source_waist, target_waist = waist_fit['source_height'], waist_fit['target_height']
                if source_height <= source_waist:
                    vertex.co.z = target_low + (source_height-source_low)/(source_waist-source_low)*(target_waist-target_low)
                else:
                    vertex.co.z = target_waist + (source_height-source_waist)/(source_high-source_waist)*(target_high-target_waist)
        rigid_indices = set()
        if original_points:
            rigid_indices = {index for face in obj.data.polygons
                             if obj.data.materials[face.material_index].name.split('.')[0] in rigid_declaration['materials']
                             for index in face.vertices}
            if rigid_indices:
                points = [original_points[index] for index in rigid_indices]
                # 卷起的腕口比拳掌更宽；只用标注的掌区定位，整件仍使用同一刚性变换。
                palm = [point for point in points if point.z <= rigid_declaration['palm_max_z']]
                source_center = Vector(tuple((min(point[axis] for point in palm) + max(point[axis] for point in palm)) / 2 for axis in range(3)))
                mapped_center = fit_point(source_center, source_box, target_box, arm_side)
                columns = [(fit_point(source_center + Vector(tuple(1 if index == axis else 0 for index in range(3))), source_box, target_box, arm_side) - mapped_center).normalized() for axis in range(3)]
                rotation = Matrix(tuple(tuple(columns[column][row] for column in range(3)) for row in range(3)))
                relative = [rotation @ (point - source_center) for point in palm]
                target = rigid_reference[arm_side]
                clearance = rigid_declaration['clearance']
                scale = max((target['bounds'][axis][1] - target['bounds'][axis][0] + 2 * clearance) / (max(point[axis] for point in relative) - min(point[axis] for point in relative)) for axis in [1, 2])
                target_center = target['center'].copy()
                for index in rigid_indices:
                    obj.data.vertices[index].co = target_center + (rotation @ (original_points[index] - source_center)) * scale
                rigid_evidence.append({'role': role, 'materials': rigid_declaration['materials'], 'vertices': len(rigid_indices), 'palm_vertices': len(palm), 'uniform_scale': scale, 'source_center': list(source_center), 'target_center': list(target_center), 'rotation': [list(row) for row in rotation], 'reference_sha256': rigid_declaration['reference']['sha256']})
        obj.parent=rig
        obj.matrix_parent_inverse=Matrix.Identity(4)
        obj.matrix_basis=Matrix.Identity(4)
        groups={bone.name:obj.vertex_groups.new(name=bone.name) for bone in rig.data.bones}
        for vertex in obj.data.vertices:
            for name,weight in weights(vertex.co,role):
                if weight>0:
                    groups[name].add([vertex.index],weight,'REPLACE')
        if rigid_indices:
            name = 'hand.l' if arm_side > 0 else 'hand.r'
            for index in rigid_indices:
                for group in obj.vertex_groups:
                    group.remove([index])
                groups[name].add([index], 1, 'REPLACE')
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
    clothing_fit = None
    if spec.get('torso_clothing_fit'):
        clothing_fit = fit_torso_clothing(bpy, bmesh, prepared['torso'] + upper, canonical_parts, spec['torso_clothing_fit'], spec.get('native_waist_accessory_top'))
    updated=dict(spec)
    for role,field in [('head','head_nodes'),('torso','body_nodes'),('left_arm','left_arm_nodes'),('right_arm','right_arm_nodes'),('left_leg','left_leg_nodes'),('right_leg','right_leg_nodes')]:
        updated[field]=[obj.name for obj in prepared[role]]
    if spec.get('scalp_source_nodes') and 'head' not in group_roles:
        head_names={name:obj.name for name,obj in zip(spec['head_nodes'],prepared['head'])}
        updated['scalp_source_nodes']=[head_names[name] for name in spec['scalp_source_nodes']]
    if spec.get('partition_scalp') and spec.get('head_adapter'):
        updated['scalp_source_nodes'] = updated['head_nodes'][:]
    updated['hair_nodes']=[obj.name for obj in hair]
    updated['upper_nodes']=[obj.name for obj in upper]
    parts={obj.name:obj for objects in prepared.values() for obj in objects}
    parts.update({obj.name:obj for obj in hair+upper})
    return parts,updated,{'method':'anatomical-part fitting to canonical segment bounds and interpolated canonical-chain skin weights','source_bounds':source_boxes,'target_head_bounds':target_head,'target_torso_bounds':target_torso,'has_source_legs':bool(prepared['left_leg'] and prepared['right_leg']),**({'torso_waist_fit':waist_fit} if waist_fit else {}), **({'torso_clothing_fit':clothing_fit} if clothing_fit else {}), **({'rigid_hand_clothing':rigid_evidence} if rigid_evidence else {})}
