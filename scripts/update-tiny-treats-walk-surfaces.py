"""从已发布房屋GLB更新可选支撑面，不重新导出模型或修改商品。"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy

ROOT = Path(__file__).resolve().parents[1]


# 使用同一加工函数提取floor面，保证旧模型补录与后续重新制作的坐标一致。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=ROOT / 'internal/assets/builtin')
    parser.add_argument('--configuration', type=Path, default=ROOT / 'internal/island/spatial-houses.json')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'internal/assets/tiny-treats-manifest.json')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    spec = importlib.util.spec_from_file_location('tiny_treats_preparation', Path(__file__).with_name('prepare-tiny-treats.py'))
    preparation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preparation)
    configuration = json.loads(args.configuration.read_text())
    manifest = json.loads(args.manifest.read_text())
    manifest_houses = {house['house_key']: house for house in manifest['houses']}
    for house in configuration['houses']:
        model = args.models / (house['house_key'] + '.glb')
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(model))
        surface = preparation.floor_walk_surface([bpy.data.objects['floor']])
        house['walk_surfaces'] = surface
        manifest_houses[house['house_key']]['walk_surfaces'] = surface
        print('房屋支撑面提取完成', house['house_key'], '顶点', len(surface['vertices']),
              '三角面', len(surface['triangles']), '字节', len(json.dumps(surface, separators=(',', ':')).encode()),
              '模型SHA256', hashlib.sha256(model.read_bytes()).hexdigest(), flush=True)
    preparation.write_geometry_json(args.configuration, configuration)
    preparation.write_geometry_json(args.manifest, manifest)


if __name__ == '__main__':
    main()
