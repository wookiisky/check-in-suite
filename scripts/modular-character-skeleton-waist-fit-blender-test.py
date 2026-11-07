"""在真实交付模型与八个动作姿势上验证骷髅腰部和闭合下装。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
LOWERS = ['kaykit-legacy-skeleton-'+name+'-lower' for name in ['archer','mage','minion','warrior']] + ['kaykit-skeletons-mage-lower']


# 复用生产组装、动作和真实三角面求值入口。
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 位置之外的源数组直接比较，避免只比较网格计数。
def attributes(obj):
    return {'faces':[list(face.vertices) for face in obj.data.polygons],
            'face_materials':[face.material_index for face in obj.data.polygons],
            'uv':[[list(loop.uv) for loop in layer.data] for layer in obj.data.uv_layers],
            'weights':[[[obj.vertex_groups[g.group].name,g.weight] for g in vertex.groups] for vertex in obj.data.vertices],
            'materials':[material.name for material in obj.data.materials]}


# 同位置的分区边在改前建立配对，改后仍须保持位置和真实蒙皮后的接合。
def seam_pairs(left, right):
    from mathutils.kdtree import KDTree

    tree=KDTree(len(right.data.vertices))
    for vertex in right.data.vertices:
        tree.insert(right.matrix_world@vertex.co,vertex.index)
    tree.balance()
    return [(a.index,index) for a in left.data.vertices
            for _,index,_ in tree.find_range(left.matrix_world@a.co,.00001)]


# 只测已查实的最低肋骨腰线以下域；屈身时上胸遮住腰带属于正常遮挡。
def waist_tree(objects, geometry):
    points,triangles=[],[]
    for obj in objects:
        evaluated,faces=geometry.evaluated_geometry(obj)
        obj.data.calc_loop_triangles()
        offset=len(points)
        points.extend(evaluated)
        for face in obj.data.loop_triangles:
            center=sum((obj.matrix_world@obj.data.vertices[i].co for i in face.vertices),Vector())/3
            if .60<center.z<.72:
                triangles.append(tuple(index+offset for index in faces[face.index]))
    return BVHTree.FromPolygons(points,triangles,all_triangles=True)


# 只检查原衣物实际可见的闭合面内部，腰口、原破洞和装饰边界不当作封闭面。
def check_shell(garment, underlying, geometry, subdivisions, lower_height=.59):
    points,triangles=geometry.evaluated_geometry(garment)
    cloth=BVHTree.FromPolygons(points,triangles,all_triangles=True)
    body=waist_tree(underlying,geometry)
    garment.data.calc_loop_triangles()
    waist_points=[points[vertex.index] for vertex in garment.data.vertices
                  if .59<(garment.matrix_world@vertex.co).z<.80]
    waist_center=sum(waist_points,Vector())/len(waist_points)
    samples,exposed,maximum,minimum=0,0,0.0,None
    examples=[]
    for face in garment.data.loop_triangles:
        rest=[garment.matrix_world@garment.data.vertices[i].co for i in face.vertices]
        center=sum(rest,Vector())/3
        if not lower_height<center.z<.80:
            continue
        rest_normal=(rest[1]-rest[0]).cross(rest[2]-rest[0]).normalized()
        if abs(rest_normal.z)>.65:
            continue
        # 开口内侧和从另一侧开口看到的远端内壁，不属于朝外的封闭外壁。
        if rest_normal.dot(Vector((center.x,center.y,0)))<.001:
            continue
        a,b,c=[points[i] for i in triangles[face.index]]
        normal=(b-a).cross(c-a).normalized()
        for direction in [Vector((1,0,0)),Vector((-1,0,0)),Vector((0,1,0)),Vector((0,-1,0))]:
            if normal.dot(direction)<.35:
                continue
            for row in range(1,subdivisions):
                for column in range(1,subdivisions-row):
                    point=a+(b-a)*(row/subdivisions)+(c-a)*(column/subdivisions)
                    if (point-waist_center).dot(direction)<.02:
                        continue
                    origin=point+direction
                    shell=cloth.ray_cast(origin,-direction,2)
                    if shell[3] is None or abs(shell[3]-1)>.00002:
                        continue
                    hit=body.ray_cast(origin,-direction,2)
                    samples+=1
                    if hit[3] is None:
                        continue
                    if hit[1].dot(direction)<=0:
                        continue
                    clearance=hit[3]-shell[3]
                    minimum=clearance if minimum is None else min(minimum,clearance)
                    if clearance<-.0002:
                        exposed+=1;maximum=max(maximum,-clearance)
                        if len(examples)<12:
                            examples.append({'cloth_triangle':face.index,'body_point':list(hit[0]),'cloth_point':list(shell[0]),'protrusion':-clearance,'direction':list(direction)})
    return {'samples':samples,'exposed':exposed,'maximum_protrusion':maximum,'minimum_clearance':minimum,'examples':examples}


# 可在归档GLB上先复现再试修，也可不带settings直接验收新制作的最终GLB。
def main(options):
    assembly=load('skeleton_waist_assembly','verify-modular-character-appearance.py')
    arm=load('skeleton_waist_arm','verify-modular-character-arms.py')
    geometry=load('skeleton_waist_geometry','modular-character-torso-back-fit-blender-test.py')
    catalog=json.loads(options.catalog.read_text())
    bodies={item['character_key']:item for item in catalog['characters']}
    wearables={item['wearable_key']:item for item in catalog['wearables']}
    reference_seams={}
    for body_key in options.body:
        body_definition=bodies[body_key]
        path=(options.seam_reference_model if body_key=='kaykit-skeleton-v1' else None)
        path=path or assembly.read_asset_source(body_definition['model_asset_key'],{},options.assets,{})
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
        nodes=['body_torso','body_legs','body_arms']
        counts={left+'/'+right:len(seam_pairs(bpy.data.objects[left],bpy.data.objects[right]))
                for i,left in enumerate(nodes) for right in nodes[i+1:]}
        assert sum(counts.values())>0,'独立基线未找到身体共享接缝'
        reference_seams[body_key]={'model':str(path),'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),'counts':counts}
    overrides=json.loads(options.overrides.read_text()) if options.overrides else {}
    by_model={}
    if options.skeleton_model:
        by_model[bodies['kaykit-skeleton-v1']['model_asset_key']]=options.skeleton_model
    for key,override in overrides.items():
        by_model[wearables[key]['model_asset_key']]=Path(override['path'])
        if override.get('node'):
            wearables[key]['nodes']=[override['node']]
    original_reader=assembly.read_asset_source
    def read_source(key,hashes,asset_directory=None,source_paths=None):
        if key not in by_model:
            return original_reader(key,hashes,asset_directory,source_paths)
        path=by_model[key]
        hashes[key]=hashlib.sha256(path.read_bytes()).hexdigest()
        if source_paths is not None:source_paths[key]=str(path)
        return path
    assembly.read_asset_source=read_source
    settings=json.loads(options.settings.read_text()) if options.settings else None
    helper=load('skeleton_waist_fit','modular-character-skeleton-waist-fit.py') if settings else None
    poses=[(item['motion'],item['frame']) for item in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
    report={'status':'running','settings':settings,'catalog_sha256':hashlib.sha256(options.catalog.read_bytes()).hexdigest(),'test_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'inputs':{},'cases':[],'source_preservation':[],'seam_references':reference_seams}
    for key in options.only:
        for body_key in options.body:
            paths={}
            body,rig,selected,hashes,selection,sources=assembly.load_appearance({'body':body_key,'selection':{'upper':'upper-none-v1','lower':key}},bodies,wearables,options.assets,paths)
            base=sources[body['model_asset_key']]
            target=[base[name] for name in ['body_torso','body_legs','body_arms']]
            before=[attributes(obj) for obj in target]
            coordinates=[[list(vertex.co) for vertex in obj.data.vertices] for obj in target]
            pairs=[(i,a,j,b) for i,left in enumerate(target) for j,right in enumerate(target) if i<j
                   for a,b in seam_pairs(left,right)]
            names=['body_torso','body_legs','body_arms']
            counts={names[i]+'/'+names[j]:sum(a==i and b==j for a,_,b,_ in pairs)
                    for i in range(3) for j in range(i+1,3)}
            assert counts==reference_seams[body_key]['counts'],'共享接缝配对数量不同于独立基线，不能跳过已裂开的原接缝'
            operation=helper.fit_skeleton_waist(target,rig,settings) if settings and body_key=='kaykit-skeleton-v1' else None
            assert before==[attributes(obj) for obj in target], '原面/UV/材质/权重变化'
            protected=[]
            if operation:
                changed={row['object']:set(row['changed_vertices']) for row in operation['objects']}
                for obj,original in zip(target,coordinates):
                    protected.append({'object':obj.name,'unchanged_positions':[[i,point] for i,point in enumerate(original) if i not in changed.get(obj.name,set())]})
                    assert all(list(obj.data.vertices[i].co)==point for i,point in protected[-1]['unchanged_positions'])
            if key==options.only[0]:
                report['source_preservation'].append({'body':body_key,'attributes':before,'protected_positions':protected,'seam_pair_count':len(pairs),'operation':operation})
            garment=sources[wearables[key]['model_asset_key']][wearables[key]['nodes'][0]]
            # 手臂经过腰前属于正常遮挡；本专项只测同处腰部的躯干和腿部身体面。
            underlying=target[:2]
            actions=arm.load_actions(bpy,body,hashes,options.assets,paths,poses)
            report['inputs'].update({name:{'path':paths[name],'sha256':value} for name,value in hashes.items()})
            for motion,frame in poses:
                arm.apply_pose(bpy,rig,body,actions,motion,frame)
                # 红裙的最低肋骨适配域为腰缘主布；更低的独立挂饰和开放裙摆不进入本专项。
                lower_height=.645 if key=='kaykit-skeletons-mage-lower' else .59
                result=check_shell(garment,underlying,geometry,options.subdivisions,lower_height)
                evaluated=[geometry.evaluated_geometry(obj)[0] for obj in target]
                result['maximum_seam_distance']=max(((evaluated[i][a]-evaluated[j][b]).length for i,a,j,b in pairs),default=0)
                assert result['maximum_seam_distance']<.00002,'原分区接缝裂开'
                result.update(body=body_key,wearable_key=key,motion=motion,frame=frame)
                report['cases'].append(result)
                print('骷髅腰部闭面检查',body_key,key,motion,frame,result['samples'],result['exposed'],flush=True)
    report['summary']={'cases':len(report['cases']),'samples':sum(row['samples'] for row in report['cases']),'exposed':sum(row['exposed'] for row in report['cases']),'maximum_protrusion':max(row['maximum_protrusion'] for row in report['cases']),'maximum_seam_distance':max(row['maximum_seam_distance'] for row in report['cases'])}
    report['status']='failed' if report['summary']['exposed'] else 'passed'
    report['limits']=['Finite eight poses and four cardinal directions; not continuous animation coverage.',
                      'Underlying body ROI is rest-space triangle centroid Z in (0.60,0.72), the proven lowest-rib domain.',
                      'Cloth sampling excludes horizontal opening rims and inward walls; red-skirt ROI begins at Z=0.645.',
                      'Verify-only compares each node-pair seam count against an independently loaded reference, then checks all current pairs after skinning; it does not claim a general UV-based cross-version seam-identity mapping.',
                      'Broad ray flags require source and visual adjudication before declaring a new visible defect; attached items and the open waist can be normally occluded.']
    options.report.parent.mkdir(parents=True,exist_ok=True)
    options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 1 if report['status']=='failed' else 0


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--assets',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--settings',type=Path)
    parser.add_argument('--overrides',type=Path)
    parser.add_argument('--skeleton-model',type=Path)
    parser.add_argument('--seam-reference-model',type=Path)
    parser.add_argument('--only',nargs='+',default=LOWERS)
    parser.add_argument('--body',nargs='+',default=['kaykit-medium-v1','kaykit-skeleton-v1'])
    parser.add_argument('--subdivisions',type=int,default=8)
    options=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    raise SystemExit(main(options))
