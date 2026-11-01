"""用实际交付GLB验证无耳骷髅的侧后壳和跨人物触角根部，不以材质外观代替几何。"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 模型以标准绑定姿势求值，源节点动作不能改变检查位置。
def load_model(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    for obj in bpy.data.objects:
        obj.animation_data_clear()
        if obj.type == 'ARMATURE':
            obj.data.pose_position = 'REST'
    bpy.context.view_layer.update()


# 眼球使用原源面片的完整UV签名识别，坐标拟合不应把它们剪掉或改为头皮。
def uv_signatures(obj, polygons):
    uv = obj.data.uv_layers.active.data
    return Counter(tuple(sorted(tuple(round(value, 5) for value in uv[index].uv) for index in polygon.loop_indices)) for polygon in polygons)


# 源已经证明没有耳朵，侧后大面必须属于可覆盖头皮。
def verify_skeleton(side_limit, expected_eyes):
    obj = bpy.data.objects['body_head']
    leaked = []
    for polygon in obj.data.polygons:
        center = sum((obj.matrix_world @ obj.data.vertices[index].co for index in polygon.vertices), Vector()) / len(polygon.vertices)
        if center.y >= 0 and abs(center.x) > side_limit + 1e-5:
            leaked.append(polygon.index)
    assert not leaked, f'skeleton rear cranial faces remained fixed: {leaked[:8]}'
    actual = uv_signatures(obj, obj.data.polygons)
    assert all(actual[face] >= count for face, count in expected_eyes.items()), 'original skeleton eye triangles were cut or moved into scalp'


# 两根棱柱只有上下端环，取下半段所有根点并核对真实标准头皮距离。
def verify_antennas(scalp):
    obj = bpy.data.objects['hair_provider']
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    middle = (min(point.z for point in points) + max(point.z for point in points)) / 2
    roots = [point for point in points if point.z < middle]
    distances = [scalp.find_nearest(point)[3] for point in roots]
    assert roots and max(distances) < .005, f'antenna roots are detached from canonical scalp: {max(distances):.4f}m'
    # 同一根环贴圆头后可埋入原生平头，但连续触角杆必须穿出实际头壳，不能在旁边悬空。
    native = bpy.data.objects['body_scalp']
    surface = BVHTree.FromPolygons([native.matrix_world @ vertex.co for vertex in native.data.vertices], [tuple(face.vertices) for face in native.data.polygons])
    for sign in [-1, 1]:
        lower = [point for point in roots if point.x * sign > 0]
        upper = [point for point in points if point.z >= middle and point.x * sign > 0]
        start = sum(lower, Vector()) / len(lower)
        end = sum(upper, Vector()) / len(upper)
        direction = end - start
        hit = surface.ray_cast(start, direction.normalized(), direction.length)[0]
        assert hit is not None, f'antenna {sign}: stem does not cross the native scalp surface'



# 两个回归各自使用实际GLB，允许对冻结旧版本做失败反证。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT / '.local/kenney-characters/workspace')
    parser.add_argument('--only', choices=['skeleton', 'alien'])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    load_model(ROOT / 'internal/assets/builtin/character-medium-v1.glb')
    obj = bpy.data.objects['body_scalp']
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    scalp = BVHTree.FromPolygons(points, [tuple(face.vertices) for face in obj.data.polygons])
    side_limit = max(abs(point.x) for point in points)
    eyes = Counter()
    if args.only != 'alien':
        configuration = json.loads((ROOT / 'scripts/kenney-character-sources.json').read_text())
        source = next(item for item in configuration['sources'] if item['key'] == 'kenney-graveyard-kit-skeleton')
        annotation = next(item for item in json.loads((ROOT / 'scripts/kenney-extra-heads.json').read_text())['heads'] if item['key'] == source['key'])
        load_model(ROOT / '.local/3d-sources/provider-packs/kenney' / source['pack_key'] / 'extracted' / source['source_relative_path'])
        original = bpy.data.objects[annotation['source_head_node']]
        identity = {index for start, end in annotation['fixed_identity_polygon_ranges'] for index in range(start, end)}
        eyes = uv_signatures(original, [polygon for polygon in original.data.polygons if polygon.index in identity])
        assert eyes, 'no original skeleton eye geometry selected'
    manifest = json.loads((args.workspace / 'internal/assets/provider-character-manifest.json').read_text())
    definitions = {entry['definition']['character_key']: entry['definition'] for entry in manifest['characters']}
    for label, key in [('skeleton', 'kenney-graveyard-kit-skeleton'), ('alien', 'kenney-space-kit-alien')]:
        if args.only and args.only != label:
            continue
        load_model(args.workspace / 'internal/assets/builtin' / (definitions[key]['model_asset_key'] + '.glb'))
        verify_skeleton(side_limit, eyes) if label == 'skeleton' else verify_antennas(scalp)
        print('头饰兼容检查通过', key)


if __name__ == '__main__':
    main()
