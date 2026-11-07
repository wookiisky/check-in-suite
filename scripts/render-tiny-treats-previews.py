"""根据实际模型和场景配置生成商品缩略图、场景总览及四向剖墙证据。"""

import argparse
import copy
import shutil
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CONTENT = json.loads(Path(__file__).with_name('tiny-treats-content.json').read_text())
SCENES = json.loads(Path(__file__).with_name('tiny-treats-scenes.json').read_text())['scenes']


# 固定景物的物理范围包含实际比例，避免渲染缩放后阻挡仍沿用原尺寸。
def scene_definitions(assets, sources=None):
    catalog = {item['key']: item for item in assets}
    scenes = []
    for source in SCENES if sources is None else sources:
        scene = {key: value for key, value in source.items() if key != 'landscape'}
        scene['thumbnail_asset_key'] = scene['scene_key'] + '-thumbnail'
        scene['thumbnail_url'] = '/api/v1/assets/' + scene['thumbnail_asset_key']
        scene['fixed_objects'] = []
        for index, instance in enumerate(source['landscape']):
            asset = catalog[instance['asset_key']]
            scale = instance.get('scale', 1)
            blocks_placement = asset.get('blocks_placement', True)
            footprint = {axis: math.ceil(size * scale) for axis, size in asset['footprint'].items()}
            fixed = dict(key=scene['scene_key'] + '-landscape-' + str(index + 1), model_url=asset['url'],
                         x_cm=instance['x_cm'], z_cm=instance['z_cm'], rotation=instance.get('rotation', 0),
                         scale=scale, footprint=footprint, blocks_placement=blocks_placement)
            if blocks_placement:
                fixed['walk_obstacle'] = dict(zip(('width_cm', 'depth_cm'), [math.ceil(size * scale) for size in asset['obstacle_cm']]))
            scene['fixed_objects'].append(fixed)
        scenes.append(scene)
    return scenes


# 各类模型仍共用已有的灯光、取景和输出实现。
def renderer_module():
    spec = importlib.util.spec_from_file_location('tiny_treats_renderer', Path(__file__).with_name('render-gltf-previews.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


# 缩略图使用实际交付GLB，镜头调整不会改变模型或正式加工结果。
def model_thumbnail(renderer, model, output):
    import bpy
    from mathutils import Vector
    renderer.render_model(dict(key=model.stem, model=str(model), output_directory=str(output.parent / 'thumbnail-work')), renderer.render_settings(dict(size=256, views=['front'], elevation=.5)))
    camera = bpy.context.scene.camera
    objects = [item for item in bpy.context.scene.objects if item.type == 'MESH']
    points = [item.matrix_world @ Vector(corner) for item in objects for corner in item.bound_box]
    center = Vector(tuple((min(point[axis] for point in points) + max(point[axis] for point in points)) / 2 for axis in range(3)))
    distance = (camera.location - center).length
    camera.location = center + Vector((1.15, -1.8, 1.05)).normalized() * distance
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)


# 场景缩略图先按同一物理配置搭出地面和景物，不放未购买的房屋或家具。
def scene_preview_model(scene, directory, output):
    import bpy
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    colors = {'grass': (.29, .54, .28, 1), 'sand': (.72, .61, .39, 1), 'water': (.18, .47, .62, 1)}
    for region in scene['regions']:
        mesh = bpy.data.meshes.new(region['terrain'])
        vertices = [(point['x_cm'] / 100, -point['z_cm'] / 100, -.03 if region['terrain'] == 'water' else 0) for point in region['polygon']]
        mesh.from_pydata(vertices, [], [list(range(len(vertices)))])
        mesh.update()
        surface = bpy.data.materials.new(region['terrain'])
        surface.diffuse_color = colors[region['terrain']]
        surface.use_nodes = True
        bsdf = surface.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = colors[region['terrain']]
        bsdf.inputs['Roughness'].default_value = .45 if region['terrain'] == 'water' else .95
        item = bpy.data.objects.new(region['terrain'], mesh)
        bpy.context.collection.objects.link(item)
        item.data.materials.append(surface)
    for fixed in scene['fixed_objects']:
        previous = set(bpy.context.scene.objects)
        key = fixed['model_url'].rsplit('/', 1)[1]
        bpy.ops.import_scene.gltf(filepath=str(directory / (key + '.glb')))
        imported = set(bpy.context.scene.objects) - previous
        # 用空根统一施加地面变换，保留源模型自身落地平移。
        root = bpy.data.objects.new(fixed['key'], None)
        bpy.context.collection.objects.link(root)
        for item in imported:
            if item.parent not in imported:
                item.parent = root
        root.location = Vector((fixed['x_cm'] / 100, -fixed['z_cm'] / 100, 0))
        root.rotation_euler.z = -fixed['rotation'] * math.pi / 2
        root.scale = (fixed['scale'],) * 3
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_yup=True, export_animations=False)


# 片段只含正式契约字段，制作检查数据不混入运行素材目录。
def release_fragments(manifest, directory):
    fields = {'key', 'name', 'kind', 'format', 'url', 'source_url', 'license', 'provider', 'pack_key'}
    catalog = [{key: value for key, value in asset.items() if key in fields} for asset in manifest['assets']]
    (directory / 'builtin-catalog-fragment.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
    houses = {house['house_key']: house for house in manifest['houses']}
    items = []
    for variant in CONTENT['houses']:
        key = variant['house_key']
        if key not in houses:
            continue
        footprint = houses[key]['footprint']
        items.append(dict(item_key=key, name=variant['name'], house_key=key, assembly='house',
                          model_url='/api/v1/assets/' + key, thumbnail_asset_key=houses[key]['thumbnail_asset_key'],
                          thumbnail_url=houses[key]['thumbnail_url'], provider='tiny-treats',
                          pack_key='homely-house', coin_price=variant['coin_price'], diamond_price=0, free=False,
                          footprint=footprint, walk_obstacle=footprint, blocks_placement=True, movable=True,
                          repeatable=False, spaces=['outdoor'], rotations=[0], allowed_terrain=['grass', 'sand']))
    (directory / 'spatial-items-fragment.json').write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n')
    return items


# 按稳定身份合并当批定义，保留既有字段和其他条目。
def merge_entries(previous, incoming, identity):
    indexed = {item[identity]: item for item in previous}
    for item in incoming:
        indexed[item[identity]] = {**indexed.get(item[identity], {}), **item}
    return list(indexed.values())


# 缩略图字节和元数据共同决定新身份，重画不会覆盖已发布版本。
def thumbnail_asset(renderer, model, staging, label, metadata):
    path = staging / (label + '.png')
    model_thumbnail(renderer, model, path)
    data = path.read_bytes()
    version = hashlib.sha256(data + json.dumps(metadata, sort_keys=True).encode()).hexdigest()[:12]
    key = label + '-' + version
    return {**metadata, 'key': key, 'url': '/api/v1/assets/' + key, 'output_sha256': hashlib.sha256(data).hexdigest()}, path


# 对已有候选补预览，不重新制作几何，也不隐式扩展场景选择。
def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', '--output', dest='directory', type=Path, default=ROOT / '.local/asset-pipeline/scene')
    parser.add_argument('--evidence', type=Path)
    if arguments is None:
        arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    args = parser.parse_args(arguments)
    pipeline_spec = importlib.util.spec_from_file_location('tiny_preview_pipeline', Path(__file__).with_name('asset-pipeline.py'))
    pipeline = importlib.util.module_from_spec(pipeline_spec)
    pipeline_spec.loader.exec_module(pipeline)
    helper = pipeline.candidate_tools()
    output = helper.validate_candidate_output(ROOT, args.directory)
    previous = pipeline.verify_candidate(ROOT, output)
    for item in previous['baseline']:
        path = ROOT / item['path']
        actual = helper.file_hash(path) if path.exists() else None
        if actual != item['sha256']:
            raise ValueError('candidate baseline changed: ' + item['path'])
    baseline = helper.capture_baseline(ROOT)
    baseline.update({item['path']: item['sha256'] for item in previous['baseline']})
    manifest_path = output / 'internal/assets/tiny-treats-manifest.json'
    manifest = copy.deepcopy(json.loads(manifest_path.read_text()))
    evidence = args.evidence.resolve() if args.evidence else output / 'work/tiny-treats-previews'
    if not evidence.is_relative_to(output):
        raise ValueError('preview evidence must stay inside candidate')
    staging = evidence / 'staged-thumbnails'
    staging.mkdir(parents=True, exist_ok=True)
    models = output / 'internal/assets/builtin'
    config_paths = [Path(__file__), Path(__file__).with_name('tiny-treats-content.json'), Path(__file__).with_name('tiny-treats-scenes.json'), Path(__file__).with_name('render-gltf-previews.py'), Path(__file__).with_name('render-gltf-previews-content.json')]
    dependencies = [*previous.get('dependencies', []), *helper.capture_dependencies(ROOT, config_paths)]
    renderer = renderer_module()
    assets = []
    pending_files = []
    variants = {item['house_key']: item for item in CONTENT['houses']}
    for house in manifest['houses']:
        key = house['house_key']
        variant = variants[key]
        model = models / (key + '.glb')
        metadata = dict(name=variant['name'], kind='island', format='png', source_url=CONTENT['source_urls']['homely-house'], license=CONTENT['license'], provider='tiny-treats', pack_key='homely-house')
        asset, path = thumbnail_asset(renderer, model, staging, key + '-thumbnail', metadata)
        assets.append(asset)
        pending_files.append((path, models / (asset['key'] + '.png')))
        house.update(thumbnail_asset_key=asset['key'], thumbnail_url=asset['url'])
        for view, hidden in [('front', 'south'), ('right', 'east'), ('back', 'north'), ('left', 'west')]:
            visible = ['floor'] + ['wall_' + side for side in ('north', 'south', 'east', 'west') if side != hidden]
            renderer.render_model(dict(key=key, model=str(model), visible_nodes=visible, output_directory=str(evidence / (key + '-cutaway'))), renderer.render_settings(dict(size=384, views=[view], elevation=.9)))
    source_scenes = {item['scene_key']: item for item in SCENES}
    requested = list(dict.fromkeys([*manifest.get('scene_keys', []), *[item['scene_key'] for item in manifest.get('scenes', [])]]))
    selected = []
    gaps = []
    available = {item['key'] for item in manifest['assets'] if (models / (item['key'] + '.glb')).exists()}
    for key in requested:
        source = source_scenes[key]
        missing = sorted({item['asset_key'] for item in source['landscape']} - available)
        if missing:
            gaps.append({'scene_key': key, 'missing_assets': missing})
        else:
            selected.append(source)
    scenes = scene_definitions(manifest['assets'], selected)
    for scene in scenes:
        model = evidence / (scene['scene_key'] + '-overview.glb')
        scene_preview_model(scene, models, model)
        pack = 'pretty-park' if scene['scene_key'] == 'lakeside-garden-v1' else 'homely-house'
        metadata = dict(name=scene['name'], kind='scene', format='png', source_url=CONTENT['source_urls'][pack], license=CONTENT['license'], provider='tiny-treats', pack_key=pack)
        asset, path = thumbnail_asset(renderer, model, staging, scene['scene_key'] + '-thumbnail', metadata)
        assets.append(asset)
        pending_files.append((path, models / (asset['key'] + '.png')))
        scene.update(thumbnail_asset_key=asset['key'], thumbnail_url=asset['url'])
    manifest['assets'] = merge_entries(manifest['assets'], assets, 'key')
    manifest['scenes'] = scenes
    manifest['preview_gaps'] = gaps
    fragments = output / 'fragments/tiny-treats'
    fragments.mkdir(parents=True, exist_ok=True)
    items = release_fragments(manifest, fragments)
    (fragments / 'tiny-treats-scenes.json').write_text(json.dumps({'scenes': scenes}, ensure_ascii=False, indent=2) + '\n')
    houses_path = output / 'internal/island/spatial-houses.json'
    scenes_path = output / 'internal/island/spatial-scenes.json'
    houses_source = houses_path if houses_path.exists() else ROOT / 'internal/island/spatial-houses.json'
    scenes_source = scenes_path if scenes_path.exists() else ROOT / 'internal/island/spatial-scenes.json'
    dependencies.extend(helper.capture_dependencies(ROOT, [path for path in [houses_source, scenes_source] if path.exists() and not path.is_relative_to(output)]))
    houses = json.loads(houses_source.read_text()) if houses_source.exists() else {'houses': [], 'catalog': []}
    houses['houses'] = merge_entries(houses['houses'], manifest['houses'], 'house_key')
    houses['catalog'] = merge_entries(houses['catalog'], items, 'item_key')
    wrappers = json.loads(scenes_source.read_text()) if scenes_source.exists() else []
    by_key = {item['scene_key']: item for item in wrappers}
    for scene in scenes:
        old = by_key.get(scene['scene_key'], {})
        runtime = {**old.get('scene', {}), **scene}
        by_key[scene['scene_key']] = {**old, 'scene_key': scene['scene_key'], 'name': scene['name'], 'thumbnail_asset_key': scene['thumbnail_asset_key'], 'thumbnail_url': scene['thumbnail_url'], 'free': old.get('free', False), 'default_environment': scene['default_environment'], 'scene': runtime}
    registry_path = models / 'catalog.json'
    registry = json.loads(registry_path.read_text())
    fields = {'key', 'name', 'kind', 'format', 'url', 'source_url', 'license', 'provider', 'pack_key'}
    registry = merge_entries(registry, [{key: value for key, value in asset.items() if key in fields} for asset in assets], 'key')
    updates = {manifest_path: manifest, registry_path: registry, houses_path: houses, scenes_path: list(by_key.values())}
    snapshots = {path: path.read_bytes() if path.exists() else None for path in updates}
    created = []
    try:
        for source, target in pending_files:
            if target.exists() and target.read_bytes() != source.read_bytes():
                raise ValueError('immutable thumbnail changed: ' + target.name)
            if not target.exists():
                created.append(target)
                shutil.copyfile(source, target)
        for path, value in updates.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        helper.finalize_candidate(ROOT, output, 'tiny-treats', baseline=baseline, dependencies=dependencies, processing='pending' if gaps else 'passed')
    except Exception:
        for path, data in snapshots.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        for path in created:
            path.unlink(missing_ok=True)
        raise
    print('房屋与场景预览完成', len(manifest['houses']), len(scenes), flush=True)


if __name__ == '__main__':
    main()
