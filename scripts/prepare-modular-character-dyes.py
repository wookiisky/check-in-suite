"""从已经适配身体的 GLB 生成染色版本，保留网格、蒙皮与原有部件边界。"""

import argparse
from collections import defaultdict
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REGIONS = Path(__file__).with_name('modular-character-dye-regions.json')


# 文件名带连字符，按路径加载共用的 GLB 和素材发布工具。
def load_module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# KayKit 图集每行八格、每列四格。用三角形内部的 UV 核对选区边界。
def select_triangles(surface, region):
    tiles = {tuple(tile) for tile in region['tiles']}
    max_v = region.get('max_v', 1)

    def contains(u, v):
        return (int(u * 8), int(v * 4)) in tiles and v < max_v

    selected = set()
    for index, triangle in enumerate(surface.triangles):
        coordinates = [surface.uvs[vertex] for vertex in triangle]
        center_u, center_v = (sum(values) / 3 for values in zip(*coordinates))
        inside = contains(center_u, center_v)
        # 贴图接缝处允许顶点刚好落在边界上，检查靠近顶点的面内采样。
        if any(contains(u * 0.98 + center_u * 0.02, v * 0.98 + center_v * 0.02) != inside for u, v in coordinates):
            raise ValueError('染色选区穿过三角形边界')
        if inside:
            selected.add(index)
    return selected


# 更新模型引用时保留稳定的角色、穿戴和缩略图身份。
def update_model_references(items, replacements):
    for item in items:
        current = item['model_asset_key']
        if current in replacements:
            item['model_asset_key'] = replacements[current]['key']
            item['model_url'] = replacements[current]['url']


# 共用一个源 GLB 的穿戴一起加工，未选中的节点保留原始材质。
def prepare_dyes(documents, recipes, model_dir, output):
    glb = load_module('modular-character-dye-glb')
    publish = load_module('prepare-modular-characters').publish
    catalog, manifest, assets = (documents[key] for key in ('catalog', 'manifest', 'assets'))
    wearables = {item['wearable_key']: item for item in catalog['wearables']}
    model_metadata = {item['key']: item for item in assets}
    grouped = defaultdict(list)
    for key, recipe in recipes.items():
        item = wearables[key]
        if item.get('dye_material') or not set(recipe['nodes']).issubset(item['nodes']):
            raise ValueError(f'穿戴无法应用染色配方 {key}')
        grouped[item['model_asset_key']].append((item, recipe))

    output.mkdir(parents=True, exist_ok=True)
    replacements = {}
    for model_key, entries in grouped.items():
        source = glb.Glb((model_dir / (model_key + '.glb')).read_bytes())
        for item, recipe in entries:
            material = 'dye_' + item['wearable_key'].replace('-', '_')
            selections = {}
            for name, region in recipe['nodes'].items():
                for index in range(source.primitive_count(name)):
                    selected = select_triangles(source.surface(name, index), region)
                    if selected:
                        selections[name, index] = selected
                if not any(node == name for node, _ in selections):
                    raise ValueError(f'染色选区没有命中网格 {item["wearable_key"]}/{name}')
            color = recipe.get('default_srgb')
            rgb = tuple(bytes.fromhex(color[1:])) if color else None
            source.add_dye(material, selections, rgb)
            item.update(dye_material=material, default_color_key=recipe['default_color'])

        metadata = model_metadata[model_key]
        label = model_key.removeprefix('modular-').rsplit('-', 1)[0]
        key = publish(source.to_bytes(), 'glb', label, metadata, output)
        replacements[model_key] = {**metadata, 'key': key, 'url': '/api/v1/assets/' + key}

    update_model_references(catalog['characters'] + catalog['wearables'], replacements)
    update_model_references((item['definition'] for item in manifest['characters']), replacements)
    manifest['assets'] = [replacements.get(item['key'], item) for item in manifest['assets']]
    documents['assets'] = [replacements.get(item['key'], item) for item in assets]
    return list(replacements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--regions', type=Path, default=REGIONS)
    parser.add_argument('--only', action='append')
    options = parser.parse_args()
    documents = json.load(sys.stdin)
    recipes = json.loads(options.regions.read_text())
    if options.only:
        recipes = {key: recipes[key] for key in options.only}
    retired = prepare_dyes(documents, recipes, options.models, options.output)
    print(json.dumps({**documents, 'retired_models': retired}, ensure_ascii=False))


if __name__ == '__main__':
    main()
