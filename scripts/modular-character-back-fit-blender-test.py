"""真实披肩与默认服装的后领回归；报告只写显式指定的隔离目录。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 加载制作或组装入口，不运行其命令行。
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 报告绑定实际读取的素材字节。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 求值后的表面参与真实遮挡，不能用静止包围盒代替。
def surface(objects):
    graph = bpy.context.evaluated_depsgraph_get()
    points, triangles = [], []
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(points)
        points.extend(evaluated.matrix_world @ vertex.co for vertex in mesh.vertices)
        triangles.extend(tuple(offset+index for index in triangle.vertices) for triangle in mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return BVHTree.FromPolygons(points, triangles, all_triangles=True)


# 源顶点、索引面、UV、实际材质及权重独立快照，允许的位置变形另行验证。
def attributes(obj):
    mesh = obj.data
    return {'topology': [list(face.vertices) for face in mesh.polygons],
            'uv': [[list(value.uv) for value in layer.data] for layer in mesh.uv_layers],
            'material_indices': [face.material_index for face in mesh.polygons],
            'materials': [(material.name, list(material.diffuse_color),
                           [list(node.inputs['Base Color'].default_value) for node in material.node_tree.nodes if node.type=='BSDF_PRINCIPLED'] if material.use_nodes else []) for material in mesh.materials],
            'weights': [[(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups] for vertex in mesh.vertices]}


# 所有射线随真实胸骨移动，只比较原本确有后领闭面的区域。
def probes(rig, original, fitted, collider, verify_only=False):
    rest = rig.data.bones['chest']
    pose = rig.pose.bones['chest']
    deform = rig.matrix_world @ pose.matrix @ rest.matrix_local.inverted() @ rig.matrix_world.inverted()
    anchor = rig.matrix_world @ rest.tail_local
    lateral = ((rig.matrix_world @ rig.data.bones['upperarm.l'].head_local) - (rig.matrix_world @ rig.data.bones['upperarm.r'].head_local)).normalized()
    vertical = ((rig.matrix_world @ rest.tail_local)-(rig.matrix_world @ rest.head_local)).normalized()
    posterior = vertical.cross(lateral).normalized()
    records = []
    for row in range(11):
        for column in range(31):
            base = anchor + lateral*(-.075+column*.005) + vertical*(-.035+row*.0035)
            origin = deform @ (base+posterior*1.2)
            direction = (deform.to_3x3() @ -posterior).normalized()
            before = original.ray_cast(origin, direction, 3)
            if not verify_only:
                if before[0] is None:
                    continue
                local_before = deform.inverted() @ before[0]
                if (local_before-anchor).dot(posterior) < .12:
                    continue
            cloth = fitted.ray_cast(origin,direction,3)
            under = collider.ray_cast(origin,direction,3)
            posterior_cloth = cloth[0] is not None and ((deform.inverted() @ cloth[0])-anchor).dot(posterior) >= .12
            exposed = (verify_only and not posterior_cloth) or (under[3] is not None and (cloth[3] is None or under[3] < cloth[3]-.0001))
            records.append({'grid': [column,row], 'domain_distance': before[3],
                            'cloak_distance': cloth[3], 'under_distance': under[3],
                            'exposed': exposed,
                            'clearance': under[3]-cloth[3] if under[3] is not None and cloth[3] is not None else None})
    return records


class BackFitActualGLBTest(unittest.TestCase):
    """以最终身体、披肩和共享动作验证后领的闭面遮挡。"""

    # 用两种身体的实际动作检查保留的棕披肩。
    def test_real_back_neck_fit(self):
        assembly = load('back_test_assembly','verify-modular-character-appearance.py')
        arm = load('back_test_arm','verify-modular-character-arms.py')
        fit = load('back_test_fit','modular-character-back-fit.py')
        catalog = json.loads(OPTIONS.catalog.read_text())
        bodies = {item['character_key']:item for item in catalog['characters']}
        wearables = {item['wearable_key']:item for item in catalog['wearables']}
        settings = json.loads(OPTIONS.settings.read_text())
        poses = [(item['motion'],item['frame']) for item in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
        report = {'settings':settings,'catalog_sha256':sha(OPTIONS.catalog),'cases':[], 'inputs':{},'status':'running',
                  'mode':'verify-existing-fit' if OPTIONS.verify_only else 'apply-fit-and-check',
                  'fit_applied':not OPTIONS.verify_only,
                  'domain_reference':'fixed rear-neck grid supported by the unfitted TDD baseline; no before values generated' if OPTIONS.verify_only else 'actual unmodified input cloak snapshot'}
        failures=[]
        key = 'kaykit-skeletons-minion-back-cloak'
        for body_key in bodies:
            paths={}
            body,rig,selected,hashes,selection,sources = assembly.load_appearance({'body':body_key,'selection':{'back':key}},bodies,wearables,OPTIONS.asset_directory,paths)
            item=wearables[key]
            cloak=sources[item['model_asset_key']]['back_cloak']
            before_attributes=attributes(cloak)
            source_vertices=len(cloak.data.vertices)
            source_faces=len(cloak.data.polygons)
            old_coordinates=[vertex.co.copy() for vertex in cloak.data.vertices]
            operation=({'method':'verification-only-no-fit','moved_vertices':[],'maximum_displacement':0.0} if OPTIONS.verify_only else fit.fit_back_neck(cloak,rig,settings))
            new_coordinates=[vertex.co.copy() for vertex in cloak.data.vertices]
            self.assertEqual(before_attributes,attributes(cloak),'位置之外的源属性发生变化')
            changed={vertex.index for vertex,before in zip(cloak.data.vertices,old_coordinates) if (vertex.co-before).length > 1e-8}
            self.assertEqual(changed,set(operation['moved_vertices']),'位移超出报告中的局部域')
            under=[sources[body['model_asset_key']][name] for name in body['body_regions']['torso']]
            upper=wearables[selection['upper']]
            if not upper.get('empty'):
                under.extend(sources[upper['model_asset_key']][name] for name in upper['nodes'])
            actions=arm.load_actions(bpy,body,hashes,OPTIONS.asset_directory,paths,poses)
            report['inputs'].update({name:{'path':paths[name],'sha256':value} for name,value in hashes.items()})
            for motion,frame in poses:
                arm.apply_pose(bpy,rig,body,actions,motion,frame)
                fitted=surface([cloak]);collider=surface(under)
                for vertex,coordinate in zip(cloak.data.vertices,old_coordinates):vertex.co=coordinate
                cloak.data.update();bpy.context.view_layer.update();original=surface([cloak])
                for vertex,coordinate in zip(cloak.data.vertices,new_coordinates):vertex.co=coordinate
                cloak.data.update();bpy.context.view_layer.update()
                records=probes(rig,original,fitted,collider,OPTIONS.verify_only)
                exposed=[record for record in records if record['exposed']]
                entry={'body':body_key,'wearable_key':key,'motion':motion,'frame':frame,'probes':len(records),'exposed':len(exposed),'minimum_clearance':min((record['clearance'] for record in records if record['clearance'] is not None),default=None),'fit_operation':operation,'details':records,'source_attributes_preserved':None if OPTIONS.verify_only else True,'attributes_unchanged_during_test':True,'source_vertices':source_vertices,'source_faces':source_faces,'unmoved_vertices':source_vertices-len(changed)}
                report['cases'].append(entry)
                if exposed:failures.append({k:entry[k] for k in ['body','wearable_key','motion','frame','exposed','minimum_clearance']})
            if OPTIONS.candidate_output:
                arm.apply_pose(bpy,rig,body,actions,'rest',0)
                # 小候选只含目标披肩和同一骨架，正式共享模型由主制作流程集成。
                bpy.ops.object.select_all(action='DESELECT');cloak.select_set(True);rig.select_set(True);bpy.context.view_layer.objects.active=rig
                target=OPTIONS.candidate_output/(body_key+'--'+key+'.glb');target.parent.mkdir(parents=True,exist_ok=True)
                bpy.ops.export_scene.gltf(filepath=str(target),export_format='GLB',use_selection=True,export_animations=False,export_skins=True,export_def_bones=False)
        report.update(status='failed' if failures else 'passed',failures=failures,summary={'cases':len(report['cases']),'probes':sum(case['probes'] for case in report['cases']),'exposed':sum(case['exposed'] for case in report['cases'])})
        OPTIONS.report.parent.mkdir(parents=True,exist_ok=True);OPTIONS.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        self.assertFalse(failures,json.dumps(failures,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--asset-directory',type=Path,required=True)
    parser.add_argument('--settings',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--candidate-output',type=Path)
    parser.add_argument('--verify-only','--already-fitted',action='store_true',dest='verify_only')
    OPTIONS=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(BackFitActualGLBTest))
    if not result.wasSuccessful():raise SystemExit(1)
