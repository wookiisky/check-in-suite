"""验证平面profile的实际GLB在隐藏头皮后仍保留正面脸壳，不约束3D眼窝或发际的封闭。"""
import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 三条正面射线至少命中一处固定脸；眼窝或发际处可以开口，不能靠头皮通过。
def verify_fixed_face(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    for obj in bpy.data.objects:
        obj.animation_data_clear()
        if obj.type == 'ARMATURE':
            obj.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    head = bpy.data.objects['body_head']
    surface = BVHTree.FromObject(head, bpy.context.evaluated_depsgraph_get())
    hits = []
    for x, z in [(-.1, 1.58), (0, 1.65), (.1, 1.72)]:
        point = surface.ray_cast(Vector((x, -2, z)), Vector((0, 1, 0)))[0]
        hits.append(point is not None and point.y < 0)
    assert any(hits), f'{path.name}: fixed face missing at all front samples'


# 默认检查整个试加工批次，也可以对历史失败模型单独做反证。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT / '.local/kenney-characters/workspace')
    parser.add_argument('--model', type=Path)
    parser.add_argument('--only', action='append', default=[])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if args.model:
        verify_fixed_face(args.model)
        return
    manifest = json.loads((args.workspace / 'internal/assets/provider-character-manifest.json').read_text())
    records = [entry for entry in manifest['characters'] if isinstance(entry.get('normalization'), dict) and entry['normalization'].get('head_envelope') and (not args.only or entry['definition']['character_key'] in args.only)]
    assert records, 'no prepared characters selected'
    for entry in records:
        verify_fixed_face(args.workspace / 'internal/assets/builtin' / (entry['definition']['model_asset_key'] + '.glb'))
    print('实际GLB平面固定脸正面射线检查通过', len(records))


if __name__ == '__main__':
    main()
