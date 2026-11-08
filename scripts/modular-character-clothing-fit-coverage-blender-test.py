"""以真实身体、动作和审图方向检查闭拳腕口是否仍露肤，不用穿入检查代替覆盖检查。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
# 标准腕段及已实际定位的掌根斑点；右手原本为开放护手，不在闭拳覆盖契约内。
SCOPE = (.705, .842)


# 复用正式动作与真实蒙皮求值工具，不复用制作器声称的覆盖结果。
def load_tool(name, filename):
    specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


# 同一动作只载入一次；片段与资源均来自传入的实际目录。
def load_actions(bpy, bodies, directories, tools, hashes):
    actions, loaded = {}, {}
    for body in bodies:
        for motion in ['idle', 'cheer', 'read']:
            definition = body['animations'][motion]
            key = definition['asset_key'], definition['clip']
            if key in actions:
                continue
            if definition['asset_key'] not in loaded:
                path = tools.asset_path(definition['asset_key'], directories)
                before = set(bpy.data.actions)
                bpy.ops.import_scene.gltf(filepath=str(path))
                loaded[definition['asset_key']] = set(bpy.data.actions) - before
                hashes[definition['asset_key']] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            actions[key] = next(action for action in loaded[definition['asset_key']]
                                if action.name.partition('|')[-1] == definition['clip'] or action.name == definition['clip'])
    return actions


# 在绑定姿势的真实腕区取每三角15个重心网格点，后续按同一三角求真实动画位置。
def wrist_probes(bpy, objects, tools):
    from mathutils import Vector

    probes = []
    for obj in objects:
        points, triangles = tools.evaluated_mesh(bpy, obj)
        for index, triangle in enumerate(triangles):
            for first in range(5):
                for second in range(5 - first):
                    weights = first / 4, second / 4, 1 - (first + second) / 4
                    point = sum((points[vertex] * weight for vertex, weight in zip(triangle, weights)), Vector())
                    if SCOPE[0] <= point.x <= SCOPE[1]:
                        probes.append((obj, index, weights, tuple(point)))
    assert probes, '实际身体没有腕区采样，不能以空样本判覆盖通过'
    return probes


# 对实际帧的完整可见几何建树；覆盖方向与768审图相同。
def make_tree(evaluated, objects):
    from mathutils.bvhtree import BVHTree

    points, triangles = [], []
    for obj in objects:
        current_points, current_triangles = evaluated[obj]
        offset = len(points)
        points.extend(current_points)
        triangles.extend(tuple(index + offset for index in triangle) for triangle in current_triangles)
    return BVHTree.FromPolygons(points, triangles, all_triangles=True)


# 从真实皮肤沿实际视线检查衣物；被另一块身体挡住的内部端面不算露肤。
def measure_coverage(probes, evaluated, skin, garment, directions):
    from mathutils import Vector

    visible = covered = hidden = 0
    examples = []
    for obj, index, weights, rest_point in probes:
        points, triangles = evaluated[obj]
        triangle = triangles[index]
        normal = (points[triangle[1]] - points[triangle[0]]).cross(points[triangle[2]] - points[triangle[0]]).normalized()
        point = sum((points[vertex] * weight for vertex, weight in zip(triangle, weights)), Vector())
        for angle, direction in directions:
            direction = Vector(direction).normalized()
            if normal.dot(direction) <= .05:
                continue
            start = point + direction * .0001
            skin_hit = skin.ray_cast(start, direction, .6)
            garment_hit = garment.ray_cast(start, direction, .6)
            if skin_hit[0] is not None:
                hidden += 1
                continue
            visible += 1
            if garment_hit[0] is not None:
                covered += 1
            elif len(examples) < 12:
                examples.append({'source_node': obj.name, 'triangle': index, 'rest_point': rest_point,
                                 'point': list(point), 'view': angle})
    assert visible, '实际视线没有可见腕区样本，不能以空样本判覆盖通过'
    return {'visible_samples': visible, 'covered': covered, 'uncovered': visible - covered,
            'body_occluded_samples': hidden, 'examples': examples}


# 真实最终GLB必须在两种身体的全部8个既定姿势里覆盖原闭拳腕缝。
def verify(options):
    import bpy

    tools = load_tool('wrist_coverage_mesh_tools', 'modular-character-arm-fit-blender-test.py')
    review = load_tool('wrist_coverage_review_views', 'verify-modular-character-arms.py')
    catalog = json.loads(options.catalog.read_text())
    item = next(item for item in catalog['wearables'] if item['wearable_key'] == options.wearable_key)
    directories = [options.assets, ROOT / 'internal/assets/builtin']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sources, hashes = {}, {}
    keys = dict.fromkeys([body['model_asset_key'] for body in catalog['characters']] + [item['model_asset_key']])
    for index, key in enumerate(keys):
        path = tools.asset_path(key, directories)
        sources[key] = tools.import_model(bpy, path, str(index))
        hashes[key] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    actions = load_actions(bpy, catalog['characters'], directories, tools, hashes)
    clothes = [sources[item['model_asset_key']][0][name] for name in item['nodes']]
    records = []
    for body in catalog['characters']:
        # 前一身体最后一帧可能是Read；源腕区必须先重置绑定姿势再选择。
        for _, rig in sources.values():
            rig.animation_data_clear()
            rig.data.pose_position = 'REST'
        bpy.context.scene.frame_set(0)
        bpy.context.view_layer.update()
        meshes, _ = sources[body['model_asset_key']]
        names = dict.fromkeys([*body['fixed_nodes'], *[name for names in body['body_regions'].values() for name in names]])
        body_objects = [meshes[name] for name in names]
        arm_objects = [meshes[name] for name in dict.fromkeys(body['body_regions']['arms'] + body['fixed_nodes'])]
        probes = wrist_probes(bpy, arm_objects, tools)
        for motion, frame in tools.POSES:
            for _, rig in sources.values():
                rig.animation_data_clear()
                rig.data.pose_position = 'REST' if motion == 'rest' else 'POSE'
                if motion != 'rest':
                    definition = body['animations'][motion]
                    action = actions[definition['asset_key'], definition['clip']]
                    rig.animation_data_create()
                    rig.animation_data.action = action
                    if action.slots:
                        rig.animation_data.action_slot = action.slots[0]
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            evaluated = {obj: tools.evaluated_mesh(bpy, obj) for obj in set(body_objects + clothes)}
            stats = measure_coverage(probes, evaluated, make_tree(evaluated, body_objects),
                                     make_tree(evaluated, clothes), review.view_directions(motion, 1))
            records.append({'body': body['character_key'], 'motion': motion, 'frame': frame, **stats})
            print('闭拳腕区覆盖检查', body['character_key'], motion, frame, stats['visible_samples'], stats['uncovered'], flush=True)
    report = {'complete': all(record['uncovered'] == 0 for record in records), 'wearable_key': options.wearable_key,
              'scope_abs_x': SCOPE, 'assets': hashes, 'catalog_sha256': hashlib.sha256(options.catalog.read_bytes()).hexdigest(),
              'method': 'Actual posed skin triangles, 15 barycentric probes, actual review camera directions; body self-occlusion excluded.',
              'records': records}
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    assert report['complete'], '闭拳腕区仍有可见皮肤，完整证据：' + str(options.report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/character/character-catalog.json')
    parser.add_argument('--assets', type=Path, default=ROOT / 'internal/assets/builtin')
    parser.add_argument('--wearable-key', required=True)
    parser.add_argument('--report', type=Path, required=True)
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    verify(parser.parse_args(arguments))
