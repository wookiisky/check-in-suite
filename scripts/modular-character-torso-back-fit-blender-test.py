"""直接检查最终衣甲下背闭面；源下摆之外的骨骼不进入闭面穿透结论。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT=Path(__file__).resolve().parents[1]


# 测试复用生产组装与动作入口，不在这里解释穿戴覆盖规则。
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 哈希绑定实际输入和专项测试，不使用目录中的预期值代替。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 实际动作求值后的世界三角面参与射线。
def evaluated_geometry(obj):
    graph=bpy.context.evaluated_depsgraph_get()
    ev=obj.evaluated_get(graph)
    mesh=ev.to_mesh()
    mesh.calc_loop_triangles()
    points=[ev.matrix_world@vertex.co for vertex in mesh.vertices]
    triangles=[tuple(face.vertices) for face in mesh.loop_triangles]
    ev.to_mesh_clear()
    return points,triangles


# BVH只包含指定物件，便于区分衣甲外壁与真正的身体表面。
def tree(objects):
    points,triangles=[],[]
    for obj in objects:
        vertices,faces=evaluated_geometry(obj)
        offset=len(points)
        points.extend(vertices)
        triangles.extend(tuple(index+offset for index in face) for face in faces)
    return BVHTree.FromPolygons(points,triangles,all_triangles=True)


# 原面支持的下背域以骨架世界单位配置，开放下摆下方不纳入检查。
def back_triangles(obj):
    obj.data.calc_loop_triangles()
    faces=[]
    for face in obj.data.loop_triangles:
        points=[obj.matrix_world@obj.data.vertices[index].co for index in face.vertices]
        center=sum(points,Vector())/3
        normal=(points[1]-points[0]).cross(points[2]-points[0]).normalized()
        if abs(center.x)<.25 and center.y>.1 and .65<center.z<1.0 and normal.y>.45:
            faces.append(face.index)
    return faces


# 每个原始闭面均匀取内部点；从背面发射，边缘开口不会被误当作闭面缺陷。
def check_pose(obj, original_coordinates, domain, underlying, subdivisions):
    new_coordinates=[vertex.co.copy() for vertex in obj.data.vertices]
    fitted_tree=tree([obj])
    body_tree=tree(underlying)
    for vertex,coordinate in zip(obj.data.vertices,original_coordinates):vertex.co=coordinate
    obj.data.update();bpy.context.view_layer.update()
    points,triangles=evaluated_geometry(obj)
    original_tree=BVHTree.FromPolygons(points,triangles,all_triangles=True)
    for vertex,coordinate in zip(obj.data.vertices,new_coordinates):vertex.co=coordinate
    obj.data.update();bpy.context.view_layer.update()
    counts,failures,maximum,minimum=0,[],0.0,None
    per_triangle=[]
    for face_index in domain:
        a,b,c=[points[index] for index in triangles[face_index]]
        tested,exposed=0,0
        for row in range(1,subdivisions):
            for column in range(1,subdivisions-row):
                point=a+(b-a)*(row/subdivisions)+(c-a)*(column/subdivisions)
                origin=point+Vector((0,.8,0))
                source=original_tree.ray_cast(origin,Vector((0,-1,0)),2)
                # 跳过被其他原衣片遮住的面，只检查原本可从背面看到的闭合外壁。
                if source[3] is None or abs(source[3]-.8)>.00001:
                    continue
                cloth=fitted_tree.ray_cast(origin,Vector((0,-1,0)),2)
                body=body_tree.ray_cast(origin,Vector((0,-1,0)),2)
                tested+=1;counts+=1
                if body[3] is None or cloth[3] is None:
                    continue
                clearance=body[3]-cloth[3]
                minimum=clearance if minimum is None else min(minimum,clearance)
                if clearance<-.0001:
                    exposed+=1;maximum=max(maximum,-clearance)
                    if len(failures)<100:failures.append({'source_triangle':face_index,'barycentric':[row/subdivisions,column/subdivisions],'body_point':list(body[0]),'cloth_point':list(cloth[0]),'protrusion':-clearance})
        per_triangle.append({'source_triangle':face_index,'samples':tested,'exposed':exposed})
    return {'samples':counts,'exposed':sum(row['exposed'] for row in per_triangle),'maximum_protrusion':maximum,'minimum_clearance':minimum,'triangles':per_triangle,'failure_examples':failures}


# 命令行只写显式报告；可对原产物TDD试修，也可只验证正式构建后的候选。
def main(options):
    assembly=load('torso_test_assembly','verify-modular-character-appearance.py')
    arm=load('torso_test_arm','verify-modular-character-arms.py')
    fit=load('torso_test_fit','modular-character-clothing-fit.py')
    preservation=load('torso_test_preservation','modular-character-back-fit-blender-test.py')
    catalog=json.loads(options.catalog.read_text())
    bodies={item['character_key']:item for item in catalog['characters']}
    wearables={item['wearable_key']:item for item in catalog['wearables']}
    adjustments=json.loads(options.adjustments.read_text()) if options.adjustments else []
    poses=[(item['motion'],item['frame']) for item in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
    report={'status':'running','fit_applied':bool(adjustments),'adjustments':adjustments,'catalog_sha256':sha(options.catalog),'test_sha256':sha(__file__),'cases':[],'inputs':{}}
    for key in options.only:
        for body_key in bodies:
            paths={}
            body,rig,selected,hashes,selection,sources=assembly.load_appearance({'body':body_key,'selection':{'upper':key}},bodies,wearables,options.asset_directory,paths)
            garment=wearables[key]
            obj=sources[garment['model_asset_key']][garment['nodes'][0]]
            source_attributes=preservation.attributes(obj)
            original=[vertex.co.copy() for vertex in obj.data.vertices]
            domain=back_triangles(obj)
            if not domain:raise ValueError('下背闭面域为空')
            original_name=obj.name
            obj.name=garment['nodes'][0]
            operation=fit.fit_upper_clothing([obj],rig,adjustments) if adjustments else None
            obj.name=original_name
            if adjustments and not operation['operations']:raise AssertionError('试修参数没有匹配任何真实衣物组件')
            if preservation.attributes(obj)!=source_attributes:raise AssertionError('衣甲位置之外的源属性发生变化')
            base=sources[body['model_asset_key']]
            under=[base[name] for name in body['fixed_nodes']+[node for nodes in body['body_regions'].values() for node in nodes] if name in base]
            actions=arm.load_actions(bpy,body,hashes,options.asset_directory,paths,poses)
            report['inputs'].update({name:{'path':paths[name],'sha256':value} for name,value in hashes.items()})
            for motion,frame in poses:
                arm.apply_pose(bpy,rig,body,actions,motion,frame)
                result=check_pose(obj,original,domain,under,options.subdivisions)
                if not result['samples']:raise AssertionError('本姿势未执行下背闭面采样')
                result.update(body=body_key,wearable_key=key,motion=motion,frame=frame,source_attributes_preserved=True if adjustments else None,source_attributes_unchanged_during_test=True,operation=operation)
                report['cases'].append(result)
                print('衣甲下背检查完成',body_key,key,motion,frame,result['samples'],result['exposed'],flush=True)
    report['summary']={'cases':len(report['cases']),'samples':sum(row['samples'] for row in report['cases']),'exposed':sum(row['exposed'] for row in report['cases']),'maximum_protrusion':max(row['maximum_protrusion'] for row in report['cases'])}
    report['status']='failed' if report['summary']['exposed'] else 'passed'
    options.report.parent.mkdir(parents=True,exist_ok=True);options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 1 if report['status']=='failed' else 0


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--asset-directory',type=Path,required=True)
    parser.add_argument('--only',nargs='+',default=['kaykit-adventurers-knight-upper'])
    parser.add_argument('--adjustments',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--subdivisions',type=int,default=64)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    raise SystemExit(main(args))
