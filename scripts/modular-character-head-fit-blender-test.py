"""以实际V8身体、脸型和动作验证颈接口；--apply-fix用于独立修复候选。"""
from pathlib import Path
import argparse,hashlib,importlib.util,json,math,sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
ROOT=Path(__file__).resolve().parents[1]

# 模块来源固定为当前工具，实际模型字节写入报告。
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

# 对真实动作求值后的三角面建树，不使用制作器给出的包络。
def surface(obj, face_indices=None):
    item=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=item.to_mesh();mesh.calc_loop_triangles()
    points=[item.matrix_world@v.co for v in mesh.vertices];triangles=[tuple(t.vertices)for t in mesh.loop_triangles if face_indices is None or t.polygon_index in face_indices]
    item.to_mesh_clear();return points,triangles

# 按静止位置焊接连通件，再匹配完整截面；不依赖 GLB 的顶点或面顺序。
def support_faces(obj, settings):
    points=[obj.matrix_world@v.co for v in obj.data.vertices]
    keys=[tuple(round(value,5)for value in point)for point in points]
    parents={key:key for key in keys}
    def root(key):
        while parents[key]!=key:
            parents[key]=parents[parents[key]];key=parents[key]
        return key
    for polygon in obj.data.polygons:
        first=root(keys[polygon.vertices[0]])
        for vertex in polygon.vertices[1:]:
            parents[root(keys[vertex])]=first
    components={}
    for polygon in obj.data.polygons:
        components.setdefault(root(keys[polygon.vertices[0]]),set()).add(polygon.index)
    segments=settings['segments']
    expected=[Vector((rx*math.cos(index*math.tau/segments),ry*math.sin(index*math.tau/segments),z))for z,rx,ry,_ in settings['sections']for index in range(segments)]
    matches=[]
    for faces in components.values():
        indices={index for face in faces for index in obj.data.polygons[face].vertices}
        actual=[points[index]for index in indices]
        if all(any((point-other).length<2e-5 for other in expected)for point in actual)and all(any((point-other).length<2e-5 for other in actual)for point in expected):
            matches.append(faces)
    if len(matches)!=1:
        return None,{'passed':False,'reason':'expected neck component not uniquely present','matching_components':len(matches),'components':len(components)}
    return matches[0],{'passed':True,'matching_components':1,'components':len(components),'support_faces':len(matches[0]),'method':'rest-position-connected-component-and-section-geometry'}

# 既有面的位置、UV、材质索引和蒙皮在追加后必须逐项不变。
def protected_mesh(obj):
    uv=obj.data.uv_layers.active
    return {'points':[tuple(v.co)for v in obj.data.vertices],
            'weights':[{obj.vertex_groups[g.group].name:g.weight for g in v.groups}for v in obj.data.vertices],
            'faces':[(tuple(p.vertices),p.material_index)for p in obj.data.polygons],
            'normals':[tuple(n.vector)for n in obj.data.corner_normals],
            'uv':[tuple(x.uv)for x in uv.data]if uv else []}

# 显式区分失败复现和修复验证；任何未通过记录都使测试失败。
def verify(options):
    assembly=load('neck_test_assembly','verify-modular-character-appearance.py');arm=load('neck_test_arm','verify-modular-character-arms.py');fix=load('neck_test_fix','modular-character-head-fit.py')
    catalog=json.loads(options.catalog.read_text());bodies={x['character_key']:x for x in catalog['characters']};wardrobe={x['wearable_key']:x for x in catalog['wearables']}
    settings=json.loads(options.settings.read_text());records=[];inputs={};protected=[]
    for body_key in bodies:
        for face in [x for x in catalog['wearables']if x['slot']=='face']:
            scenario={'body':body_key,'selection':{'face':face['wearable_key'],'head':'head-none-v1'}}
            body,rig,selected,hashes,selection,sources=assembly.load_appearance(scenario,bodies,wardrobe,options.assets);inputs.update(hashes)
            torso=sources[body['model_asset_key']]['body_torso'];before=protected_mesh(torso)
            if options.apply_fix:
                result=fix.add_body_neck_support(torso,rig,settings[body_key]);after=protected_mesh(torso)
                assert after['points'][:len(before['points'])]==before['points'],'修改原躯干顶点'
                assert after['weights'][:len(before['weights'])]==before['weights'],'修改原躯干权重'
                assert after['faces'][:len(before['faces'])]==before['faces'],'修改原躯干面'
                assert after['uv'][:len(before['uv'])]==before['uv'],'修改原躯干UV'
                assert all(sum((a-b)**2 for a,b in zip(old,new)) < 1e-8 for old,new in zip(before['normals'],after['normals'])),'修改原躯干法线'
                protected.append({'body':body_key,'face':face['wearable_key'],'status':'passed',**result})
            support_indices,component_evidence=support_faces(torso,settings[body_key])
            original_indices=set(range(len(torso.data.polygons)))-(support_indices or set())
            actions=arm.load_actions(bpy,body,hashes,options.assets,poses=arm.POSES);inputs.update(hashes)
            face_objects=[sources[face['model_asset_key']][name]for name in face['nodes']]
            for motion,frame in arm.POSES:
                arm.apply_pose(bpy,rig,body,actions,motion,frame)
                points,triangles=surface(torso);torso_tree=BVHTree.FromPolygons(points,triangles,all_triangles=True)
                fpoints=[];ftri=[]
                for obj in face_objects:
                    v,t=surface(obj);offset=len(fpoints);fpoints+=v;ftri.extend(tuple(offset+i for i in a)for a in t)
                face_tree=BVHTree.FromPolygons(fpoints,ftri,all_triangles=True)
                overlaps=torso_tree.overlap(face_tree)
                # 旧头骨有完整底壳，真实颈部应插入该壳；口腔不是本断言的判断依据。
                legacy=face['wearable_key'].startswith('face-kaykit-legacy-skeleton')
                passed=bool(overlaps)if legacy else True
                lower_interface={**component_evidence}
                if support_indices:
                    original_points,original_triangles=surface(torso,original_indices)
                    support_points,support_triangles=surface(torso,support_indices)
                    old_tree=BVHTree.FromPolygons(original_points,original_triangles,all_triangles=True)
                    new_tree=BVHTree.FromPolygons(support_points,support_triangles,all_triangles=True)
                    lower_z=settings[body_key]['sections'][0][0]+.005
                    transform=rig.matrix_world@rig.pose.bones['chest'].matrix@rig.data.bones['chest'].matrix_local.inverted()
                    reference=transform@Vector((0,0,lower_z))
                    hit,normal,_,_=old_tree.find_nearest(reference)
                    center=hit-normal*.005
                    probes=[center+Vector((dx,dy,dz))*.001 for dx,dy,dz in [(0,0,0),(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
                    signed=[]
                    for tree in [old_tree,new_tree]:
                        signed += [(point-tree.find_nearest(point)[0]).dot(tree.find_nearest(point)[1])for point in probes]
                    lower_interface.update({'maximum_signed_surface_distance':max(signed),'signed_distances':signed,'probe_count':len(probes),'passed':all(value < -1e-5 for value in signed)})
                passed=passed and lower_interface['passed']
                records.append({'body':body_key,'face':face['wearable_key'],'motion':motion,'frame':frame,'legacy_shell_interface_checked':legacy,'actual_body_face_triangle_intersections':len(overlaps),'lower_body_support_interface':lower_interface,'passed':passed})
    report={'status':'passed'if all(x['passed']for x in records)else 'failed','inputs':inputs,'settings':settings,'apply_fix':options.apply_fix,'records':records,'protected_existing_mesh':protected,'limits':['Non-legacy faces require rendered checks to reject support protruding beyond the face; intersection alone cannot establish this.','Eight specified poses, not continuous animation.']}
    options.report.parent.mkdir(parents=True,exist_ok=True);options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    assert report['status']=='passed','实际颈部仍未接入旧头骨底壳，详见 '+str(options.report)
    print('真实身体颈部与脸型检查通过',len(records),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--catalog',type=Path,required=True);parser.add_argument('--assets',type=Path,required=True);parser.add_argument('--settings',type=Path,required=True);parser.add_argument('--report',type=Path,required=True);parser.add_argument('--apply-fix',action='store_true')
    args=sys.argv[sys.argv.index('--')+1:]if '--'in sys.argv else sys.argv[1:];verify(parser.parse_args(args))
