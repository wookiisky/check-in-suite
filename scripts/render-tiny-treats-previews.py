"""根据实际模型和场景配置生成商品缩略图、场景总览及四向剖墙证据。"""

import argparse
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
def scene_definitions(assets):
    catalog = {item['key']: item for item in assets}
    scenes = []
    for source in SCENES:
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
        footprint = houses[key]['footprint']
        items.append(dict(item_key=key, name=variant['name'], house_key=key, assembly='house',
                          model_url='/api/v1/assets/' + key, thumbnail_asset_key=key + '-thumbnail',
                          thumbnail_url='/api/v1/assets/' + key + '-thumbnail', provider='tiny-treats',
                          pack_key='homely-house', coin_price=variant['coin_price'], diamond_price=0, free=False,
                          footprint=footprint, walk_obstacle=footprint, blocks_placement=True, movable=True,
                          repeatable=False, spaces=['outdoor'], rotations=[0], allowed_terrain=['grass', 'sand']))
    (directory / 'spatial-items-fragment.json').write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n')


# 正式目录只取输出片段；背景工程、总览模型和检查画面仍留在本地。
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=ROOT / CONTENT['output_directory'])
    parser.add_argument('--evidence', type=Path, default=ROOT / '.local/asset-tools/tiny-treats')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    args.evidence.mkdir(parents=True, exist_ok=True)
    manifest_path = args.directory / 'tiny-treats-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    renderer = renderer_module()
    thumbnail_assets = []
    for variant in CONTENT['houses']:
        key = variant['house_key']
        model = args.directory / (key + '.glb')
        thumbnail = args.directory / (key + '-thumbnail.png')
        model_thumbnail(renderer, model, thumbnail)
        thumbnail_assets.append(dict(key=key + '-thumbnail', name=variant['name'], kind='island', format='png', url='/api/v1/assets/' + key + '-thumbnail', source_url=CONTENT['source_urls']['homely-house'], license=CONTENT['license'], provider='tiny-treats', pack_key='homely-house', output_sha256=hashlib.sha256(thumbnail.read_bytes()).hexdigest()))
        for view, hidden in [('front', 'south'), ('right', 'east'), ('back', 'north'), ('left', 'west')]:
            visible = ['floor'] + ['wall_' + side for side in ('north', 'south', 'east', 'west') if side != hidden]
            renderer.render_model(dict(key=key, model=str(model), visible_nodes=visible, output_directory=str(args.evidence / (key + '-cutaway'))), renderer.render_settings(dict(size=384, views=[view], elevation=.9)))
    scenes = scene_definitions(manifest['assets'])
    for scene in scenes:
        model = args.evidence / (scene['scene_key'] + '-overview.glb')
        scene_preview_model(scene, args.directory, model)
        thumbnail = args.directory / (scene['thumbnail_asset_key'] + '.png')
        model_thumbnail(renderer, model, thumbnail)
        thumbnail_assets.append(dict(key=scene['thumbnail_asset_key'], name=scene['name'], kind='scene', format='png', url=scene['thumbnail_url'], source_url=CONTENT['source_urls']['pretty-park'] if scene['scene_key'] == 'lakeside-garden-v1' else CONTENT['source_urls']['homely-house'], license=CONTENT['license'], provider='tiny-treats', pack_key='pretty-park' if scene['scene_key'] == 'lakeside-garden-v1' else 'homely-house', output_sha256=hashlib.sha256(thumbnail.read_bytes()).hexdigest()))
    thumbnails = {item['key'] for item in thumbnail_assets}
    manifest['assets'] = [item for item in manifest['assets'] if item['key'] not in thumbnails] + thumbnail_assets
    manifest['scenes'] = scenes
    release_fragments(manifest, args.directory)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (args.directory / 'tiny-treats-scenes.json').write_text(json.dumps({'scenes': scenes}, ensure_ascii=False, indent=2) + '\n')
    print('房屋与场景预览完成', len(CONTENT['houses']), len(scenes), flush=True)


if __name__ == '__main__':
    main()
