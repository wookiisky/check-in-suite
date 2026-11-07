"""在实际GLB和交付动作上检查新增大腿与保留腿骨的接合。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


# 调用已存在的真实连通件分析，不用顶点索引猜测UV拆点后的部件。
def load_fitting():
    specification = importlib.util.spec_from_file_location('skeleton_knee_fitting', ROOT/'scripts/modular-character-clothing-fit.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


# 源腿骨上端的真实表面样点必须进入新增大腿，单看包围盒接触不足以证明接合。
def surface_samples(obj, component):
    from mathutils import Vector

    result = []
    for index in component['faces']:
        face = obj.data.polygons[index]
        points = [obj.matrix_world @ obj.data.vertices[i].co for i in face.vertices]
        result += points + [sum(points, Vector())/len(points)]
        result += [(start+end)/2 for start, end in zip(points, points[1:]+points[:1])]
    return result


# 测试直接读取交付目录，动作与实际模型的字节都记入报告。
def verify(options):
    import bpy
    from mathutils.bvhtree import BVHTree

    catalog = json.loads(options.catalog.read_text())
    body = next(item for item in catalog['characters'] if item['character_key']=='kaykit-skeleton-v1')
    model = options.model or options.assets/(body['model_asset_key']+'.glb')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    rig = next(obj for obj in bpy.data.objects if obj.type=='ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    legs = bpy.data.objects['body_legs']
    fitting = load_fitting()
    components = fitting.mesh_components(legs)
    thighs = {}
    shins = {}
    for component in components:
        bones = {legs.vertex_groups[group.group].name for i in component['vertices'] for group in legs.data.vertices[i].groups if group.weight>.00001}
        side = '.l' if component['center'].x>0 else '.r'
        # 髋端新环允许刚性hips权重，仍须属于同侧股骨；纯hips球和其他骨件不入选。
        if component['materials']==['Skeleton_Bone'] and 'upperleg'+side in bones and bones <= {'upperleg'+side,'hips'}:
            thighs[side] = component
        if component['materials']!=['Skeleton_Bone'] and 'lowerleg'+side in bones and 'upperleg'+side in bones:
            shins[side] = component
    assert set(thighs)==set(shins)=={'.l','.r'}, '没有找到两侧新增大腿与保留腿骨'
    sampling = json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']
    poses = [{'motion':item['motion'],'frame':item['frame']} for item in sampling['poses']]
    poses += [{'motion':motion,'normalized_time':time} for motion in sampling['motions'] for time in sampling['motion_samples']]
    report = {'model':str(model.resolve()),'model_sha256':hashlib.sha256(model.read_bytes()).hexdigest(),
              'method':'Actual source-leg face vertices/centres/edge midpoints inside generated thigh volume after actual skinning.',
              'minimum_overlap':.004,'inputs':{},'records':[]}
    actions = {}
    for pose in poses:
        motion = pose['motion']
        if motion!='rest' and motion not in actions:
            definition = body['animations'][motion]
            path = options.assets/(definition['asset_key']+'.glb')
            if not path.is_file():
                declaration = json.loads((options.assets/'reused-assets.json').read_text())
                path = ROOT/'internal/assets/builtin'/path.name
                assert hashlib.sha256(path.read_bytes()).hexdigest()==declaration[path.name], '复用动作哈希变化'
            report['inputs'][str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
            previous_objects, previous_actions = set(bpy.data.objects), set(bpy.data.actions)
            bpy.ops.import_scene.gltf(filepath=str(path))
            actions[motion] = next(action for action in set(bpy.data.actions)-previous_actions if action.name.split('|')[-1].partition('.')[0]==definition['clip'])
            for obj in set(bpy.data.objects)-previous_objects:
                bpy.data.objects.remove(obj, do_unlink=True)
        rig.animation_data_clear()
        rig.data.pose_position = 'REST' if motion=='rest' else 'POSE'
        for bone in rig.pose.bones:
            bone.rotation_mode = 'QUATERNION'
            bone.matrix_basis.identity()
        frame = pose.get('frame',0)
        if motion!='rest':
            action = actions[motion]
            rig.animation_data_create()
            rig.animation_data.action = action
            if action.slots:
                rig.animation_data.action_slot = action.slots[0]
            if 'normalized_time' in pose:
                frame = action.frame_range[0]+(action.frame_range[1]-action.frame_range[0])*pose['normalized_time']
        bpy.context.scene.frame_set(int(frame), subframe=frame%1)
        bpy.context.view_layer.update()
        evaluated = legs.evaluated_get(bpy.context.evaluated_depsgraph_get())
        points = [evaluated.matrix_world@vertex.co for vertex in evaluated.data.vertices]
        for side in ['.l','.r']:
            component = thighs[side]
            tree = BVHTree.FromPolygons(points,[tuple(evaluated.data.polygons[i].vertices) for i in component['faces']])
            margins = []
            for point in surface_samples(evaluated,shins[side]):
                hit, normal, _, distance = tree.find_nearest(point)
                if (point-hit).dot(normal)<0:
                    margins.append(distance)
            margin = max(margins,default=0)
            report['records'].append({**pose,'actual_frame':frame,'side':side,'overlap_margin':margin,'inside_samples':len(margins),'passed':margin>=report['minimum_overlap']})
    report['status'] = 'passed' if all(item['passed'] for item in report['records']) else 'failed'
    report['limits'] = ['Checks actual finite poses and normalized samples, not every continuous animation frame.','Overlap is intentional for separate low-poly bone parts; this is not a demand to weld the whole skeleton.']
    options.report.parent.mkdir(parents=True,exist_ok=True)
    options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('骷髅膝部接合检查', report['status'], sum(item['passed'] for item in report['records']), '/', len(report['records']), flush=True)
    assert report['status']=='passed', '新增大腿与保留腿骨在采样动作中没有足够重叠'


# 候选路径显式传入，测试本身不修改模型。
def main():
    arguments = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--assets',type=Path,required=True)
    parser.add_argument('--model',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    verify(parser.parse_args(arguments))


if __name__=='__main__':
    main()
