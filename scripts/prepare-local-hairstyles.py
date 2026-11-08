"""加工项目方授权的本地发型，输出可独立检查的人物素材候选。"""

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECIPE = ROOT / 'scripts/local-hairstyle-sources.json'
BLENDER_SCRIPT = ROOT / 'scripts/prepare-local-hairstyles-blender.py'
CHARACTERS = 'internal/character/character-catalog.json'
COLORS = 'internal/character/wearable-colors.json'
ASSETS = 'internal/assets/builtin/catalog.json'
SOURCE_MANIFEST = 'internal/assets/local-hairstyle-source-manifest.json'
ASSET_PREFIX = '/api/v1/assets/'


# 本地素材包的目录名和贴图引用来自源 DAE。
def source_files(source_root, number):
    name = 'PlayerHair' + number
    model = source_root / (name + '.Nin_NX_NVN') / (name + '.dae')
    document = ET.parse(model)
    images = []
    for image in document.findall('.//{*}library_images/{*}image/{*}init_from'):
        filename = Path(image.text.strip())
        if filename.name != str(filename):
            raise ValueError(f'发型贴图必须位于源模型目录内：{filename}')
        images.append(model.with_name(filename.name))
    return [model, *dict.fromkeys(images)]


# 版本身份同时绑定生成文件和入库元数据。
def register_asset(builtin, file, key, metadata, kind):
    entry = {**metadata, 'kind': kind, 'format': file.suffix[1:]}
    content = file.read_bytes()
    digest = hashlib.sha256(content + json.dumps(entry, sort_keys=True).encode()).hexdigest()
    entry['key'] = f'{key}-{digest[:12]}'
    entry['url'] = ASSET_PREFIX + entry['key']
    (builtin / (entry['key'] + file.suffix)).write_bytes(content)
    return entry


# 新候选沿用现有角色及动作，只替换同一批次的发型定义。
def assemble_candidate(output, geometry, recipe, report, sources):
    catalog = json.loads((ROOT / CHARACTERS).read_text())
    registry = json.loads((ROOT / ASSETS).read_text())
    body = next(item for item in catalog['characters'] if item['character_key'] == 'kaykit-medium-v1')
    delivery = {f'hair-local-{number}' for number in recipe['styles']}
    previous = {item['wearable_key']: item for item in catalog['wearables'] if item['wearable_key'] in delivery}
    superseded = {item[field] for item in previous.values() for field in ('model_asset_key', 'thumbnail_asset_key')}
    catalog['wearables'] = [item for item in catalog['wearables'] if item['wearable_key'] not in delivery]
    referenced = {item[field] for item in catalog['characters'] + catalog['wearables']
                  for field in ('model_asset_key', 'thumbnail_asset_key')}
    registry = [item for item in registry if item['key'] not in superseded - referenced]
    builtin = (output / ASSETS).parent
    builtin.mkdir(parents=True)
    provenance = {field: recipe[field] for field in ('provider', 'pack_key', 'pack_name', 'license')}
    manifest = {**provenance, 'wearables': []}
    for number, name in recipe['styles'].items():
        key = 'hair-local-' + number
        material = 'dye_hair_local_' + number
        metadata = {**provenance, 'name': name,
                    'source_url': 'urn:check-in-suite:asset-source:local-hairstyles/PlayerHair' + number}
        model = register_asset(builtin, geometry / (key + '.glb'), key, metadata, 'model')
        thumbnail = register_asset(builtin, geometry / (key + '.png'), key + '-thumbnail', metadata, 'wearable')
        registry.extend([model, thumbnail])
        catalog['wearables'].append({
            'wearable_key': key, 'name': name, 'slot': 'head',
            'character_key': body['character_key'], 'body_key': body['body_key'], 'rig_key': body['rig_key'],
            'provider': recipe['provider'], 'pack_key': recipe['pack_key'],
            'nodes': [key], 'covers': report[key]['covers'],
            'model_asset_key': model['key'], 'model_url': model['url'],
            'thumbnail_asset_key': thumbnail['key'], 'thumbnail_url': thumbnail['url'],
            'dye_material': material, 'default_color_key': recipe['default_color_key'],
            'sellable': previous.get(key, {}).get('sellable', True),
        })
        manifest['wearables'].append({
            'wearable_key': key,
            'source_url': metadata['source_url'],
            'sources': [{'path': path.parent.name + '/' + path.name,
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in sources[number]],
            'model_asset_key': model['key'],
            'thumbnail_asset_key': thumbnail['key'],
        })
    for filename, data in ((CHARACTERS, catalog), (ASSETS, registry), (SOURCE_MANIFEST, manifest)):
        target = output / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


# 保留加工开始前的正式基线和本地源指纹，正式资源由管线另行应用。
def build(options):
    spec = importlib.util.spec_from_file_location(
        'asset_candidate', ROOT / 'scripts/asset-pipeline-candidate.py')
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    output = candidate.validate_candidate_output(ROOT, options.output)
    if output.exists() and any(output.iterdir()):
        raise ValueError('发型候选目录须为空')
    baseline = candidate.capture_baseline(ROOT)
    recipe = json.loads(RECIPE.read_text())
    sources = {number: source_files(options.source_root.resolve(), number) for number in recipe['styles']}
    dependencies = candidate.capture_dependencies(ROOT, [
        RECIPE, BLENDER_SCRIPT, CHARACTERS, COLORS,
        ROOT / 'scripts/character_catalog_source.py',
        ROOT / 'scripts/verify-modular-character-appearance.py',
        ROOT / 'scripts/verify-modular-character-arms.py',
        *[path for files in sources.values() for path in files],
    ])
    geometry = output / 'geometry'
    subprocess.run([
        options.blender, '--background', '--factory-startup', '--python-exit-code', '1',
        '--python', str(BLENDER_SCRIPT), '--', '--source-root', str(options.source_root.resolve()),
        '--output', str(geometry),
    ], check=True, cwd=ROOT)
    report = json.loads((geometry / 'report.json').read_text())
    assemble_candidate(output, geometry, recipe, report['hairstyles'], sources)
    candidate.finalize_candidate(ROOT, output, 'local-hairstyles', baseline=baseline,
                                 dependencies=dependencies,
                                 tool_versions={'python': sys.version, 'blender': report['blender_version']})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--blender', default='/Applications/Blender.app/Contents/MacOS/Blender')
    build(parser.parse_args())
