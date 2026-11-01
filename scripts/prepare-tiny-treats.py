"""从官方免费 GLTF 制作可进入房屋；后台 Blender 只写专用暂存目录。"""

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CONTENT = json.loads(Path(__file__).with_name('tiny-treats-content.json').read_text())


# 复用已测试的免费获取流程，付费源工程不会进入下载范围。
def fetch_sources():
    spec = importlib.util.spec_from_file_location('tiny_treats_fetcher', Path(__file__).with_name('fetch-provider-assets.py'))
    fetcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetcher)
    directory = (ROOT / CONTENT['source_root']).parent
    directory.mkdir(parents=True, exist_ok=True)
    records = [fetcher.fetch_pack('tiny-treats', url, directory) for url in CONTENT['source_urls'].values()]
    (directory / 'pack-manifest.json').write_text(json.dumps({'packs': records}, ensure_ascii=False, indent=2) + '\n')
    failures = [item for item in records if item['status'] != 'downloaded']
    if failures:
        raise RuntimeError(str([(item['id'], item.get('error', item['status'])) for item in failures]))
    return records


# 几何由加工配方计算，源模型和室内空间始终使用同一变换。
def house_geometry(variant):
    scale = variant['scale_xz']
    shift = 105 * scale
    rect = lambda x0, x1, z0, z1: dict(min_x_cm=round(x0 * scale, 3), max_x_cm=round(x1 * scale, 3), min_z_cm=round(z0 * scale - shift, 3), max_z_cm=round(z1 * scale - shift, 3))
    wall_nodes = {side: ['wall_' + side] for side in ('north', 'south', 'east', 'west')}
    geometry = {
        'house_key': variant['house_key'],
        'model_url': '/api/v1/assets/' + variant['house_key'],
        'interior': rect(-228, 228, -128, 128),
        'floor_height_cm': 40,
        'wall_height_cm': 260,
        'door_center': {'x_cm': 0, 'z_cm': round(150 * scale - shift)},
        'door_width_cm': round(162 * scale),
        'door_height_cm': 250,
        'door_clearance': rect(-81, 81, 150, 432.5),
        'walls': [rect(-250, -228, -150, 150), rect(228, 250, -150, 150),
                  rect(-228, 228, -150, -128), rect(-228, -81, 128, 150), rect(81, 228, 128, 150),
                  rect(-170, -81, 150, 280), rect(81, 170, 150, 280)],
        'interior_clearances': [rect(-81, 81, 70, 150)],
        'roof_nodes': ['roof'],
        'wall_nodes': wall_nodes,
        'entry_height_profile': [dict(point) for point in variant['entry_height_profile']],
        'fixed_nodes': ['floor'],
        'footprint': {'width_cm': round(600 * scale), 'depth_cm': round(660 * scale)},
    }
    if variant['porch']:
        geometry['walls'].extend([rect(-203, -187, 374, 390), rect(187, 203, 374, 390)])
    return geometry


# 只查找已获得的免费包，未找到时明确失败，不自动换来源。
def source_model(pack, name):
    matches = sorted((ROOT / CONTENT['source_root'] / pack / 'extracted').rglob(name + '.gltf'))
    if not matches:
        raise FileNotFoundError(f'{pack}/{name}.gltf')
    return matches[0]


# 材质颜色从制作配置读取，新增内表面不依赖外链纹理。
def material(name):
    import bpy
    result = bpy.data.materials.new(name)
    result.diffuse_color = CONTENT['materials'][name]
    result.use_nodes = True
    result.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = result.diffuse_color
    result.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .85
    return result


# 立方体保留完整内侧和剖切断面，几何与通行配置同源。
def box(name, lower, upper, surface):
    import bpy
    bpy.ops.mesh.primitive_cube_add(size=1, location=tuple((a + b) / 2 for a, b in zip(lower, upper)))
    result = bpy.context.object
    result.name = name
    result.dimensions = tuple(b - a for a, b in zip(lower, upper))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    result.data.materials.append(surface)
    return result


# 同一可隐藏部分合并为一个稳定节点，前端只依赖正式节点身份。
def merge_nodes(objects, name):
    import bpy
    bpy.ops.object.select_all(action='DESELECT')
    for item in objects:
        item.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    result = bpy.context.object
    result.name = name
    return result


# 保留源网格的 UV 和材质，只按切分后的面分离屋顶及各方向外墙。
def split_exterior(source):
    import bpy
    import bmesh
    mesh = bmesh.new()
    mesh.from_mesh(source.data)
    for axis, value in [(2, .4), (2, 2.9), (2, 3.0), (0, -.81), (0, .81), (0, -2.28), (0, 2.28), (1, -1.28), (1, 1.28)]:
        normal = [0., 0., 0.]
        normal[axis] = 1.
        point = [0., 0., 0.]
        point[axis] = value
        bmesh.ops.bisect_plane(mesh, geom=list(mesh.verts) + list(mesh.edges) + list(mesh.faces), dist=.00001, plane_co=point, plane_no=normal)
    # 去掉门后的封板，整条入口从原门廊延伸到主房内部。
    blocked = []
    for face in mesh.faces:
        center = face.calc_center_median()
        door_panel = abs(center.x) < .809 and center.y < -1.279 and .405 < center.z < 2.899
        replaced_floor = abs(center.x) < 2.279 and abs(center.y) < 1.279 and abs(center.z - .4) < .001
        if door_panel or replaced_floor:
            blocked.append(face)
    bmesh.ops.delete(mesh, geom=blocked, context='FACES')
    mesh.to_mesh(source.data)
    mesh.free()
    groups = {'floor': [], 'roof': [], **{'wall_' + side: [] for side in ('north', 'south', 'east', 'west')}}
    for face in source.data.polygons:
        points = [source.data.vertices[index].co for index in face.vertices]
        if max(point.z for point in points) < .405:
            name = 'floor'
        elif min(point.z for point in points) > 2.995:
            name = 'roof'
        else:
            center = face.center
            name = ('wall_east' if center.x > 0 else 'wall_west') if abs(center.x) / 2.5 > abs(center.y) / 1.5 else ('wall_north' if center.y > 0 else 'wall_south')
        groups[name].append(face.index)
    result = {}
    for name, indices in groups.items():
        duplicate = source.copy()
        duplicate.data = source.data.copy()
        bpy.context.collection.objects.link(duplicate)
        working = bmesh.new()
        working.from_mesh(duplicate.data)
        working.faces.ensure_lookup_table()
        selected = set(indices)
        bmesh.ops.delete(working, geom=[face for face in working.faces if face.index not in selected], context='FACES')
        working.to_mesh(duplicate.data)
        working.free()
        duplicate.name = name
        result[name] = [duplicate]
    bpy.data.objects.remove(source, do_unlink=True)
    return result


# 原房屋只提供外观，补齐地板与内侧墙面后才成为可进入的房型。
def prepare_house(variant, output):
    import bpy
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = source_model('homely-house', 'house')
    bpy.ops.import_scene.gltf(filepath=str(source))
    # 先解除父子变换，后续处理全部使用源房屋世界坐标。
    for item in list(bpy.context.scene.objects):
        world = item.matrix_world.copy()
        item.parent = None
        item.matrix_world = world
    door = bpy.data.objects.get('house_door')
    bpy.data.objects.remove(door, do_unlink=True)
    body = bpy.data.objects['house']
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    groups = split_exterior(body)
    groups['roof'].extend([bpy.data.objects['house_chimney'], bpy.data.objects['house_heart']])
    inner, floor_surface, trim, roofing = [material(name) for name in ('interior', 'floor', 'trim', 'roof')]
    groups['floor'].append(box('interior_floor', (-2.5, -1.5, .30), (2.5, 1.5, .4), floor_surface))
    walls = {
        'west': [((-2.48, -1.48, .4), (-2.28, 1.48, 3.0))],
        'east': [((2.28, -1.48, .4), (2.48, 1.48, 3.0))],
        'north': [((-2.28, 1.28, .4), (2.28, 1.48, 3.0))],
        'south': [((-2.28, -1.48, .4), (-.81, -1.28, 3.0)), ((.81, -1.48, .4), (2.28, -1.28, 3.0)), ((-.81, -1.48, 2.9), (.81, -1.28, 3.0))],
    }
    for side, segments in walls.items():
        for lower, upper in segments:
            groups['wall_' + side].append(box('interior_' + side, lower, upper, inner))
    if variant['porch']:
        # 扩建款增加连续前廊及两根支柱，形成与原小屋不同的建筑体块。
        for x in (-1.95, 1.95):
            groups['wall_south'].append(box('porch_column', (x - .08, -3.9, .4), (x + .08, -3.74, 2.65), trim))
        groups['roof'].append(box('porch_canopy', (-2.08, -4.0, 2.65), (2.08, -2.55, 2.83), roofing))
        groups['floor'].append(box('porch_deck', (-2.1, -4.02, .25), (2.1, -2.65, .4), floor_surface))
    nodes = [merge_nodes(items, name) for name, items in groups.items()]
    scale = variant['scale_xz']
    for item in nodes:
        transform = item.matrix_world.copy()
        for vertex in item.data.vertices:
            value = transform @ vertex.co
            vertex.co = Vector((value.x * scale, value.y * scale + 1.05 * scale, value.z))
        item.matrix_world.identity()
    bpy.context.view_layer.update()
    model = output / (variant['house_key'] + '.glb')
    bpy.ops.export_scene.gltf(filepath=str(model), export_format='GLB', export_yup=True, export_animations=False)
    geometry = house_geometry(variant)
    points = [item.matrix_world @ vertex.co for item in nodes for vertex in item.data.vertices]
    geometry['measured_bounds_cm'] = [[round(min(point[axis] for point in points) * 100, 2), round(max(point[axis] for point in points) * 100, 2)] for axis in (0, 2, 1)]
    geometry['measured_bounds_cm'][2] = [-geometry['measured_bounds_cm'][2][1], -geometry['measured_bounds_cm'][2][0]]
    return model, geometry


# 环境模型统一落地并内嵌纹理；固定景物仍由场景数据决定阻挡。
def prepare_landscape(entry, output):
    import bpy
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = source_model(entry['pack'], entry['source'])
    bpy.ops.import_scene.gltf(filepath=str(source))
    objects = [item for item in bpy.context.scene.objects if item.type == 'MESH']
    points = [item.matrix_world @ vertex.co for item in objects for vertex in item.data.vertices]
    lower = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    upper = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (lower + upper) / 2
    offset = Vector((-center.x, -center.y, -lower.z))
    for item in bpy.context.scene.objects:
        if item.parent is None:
            item.location += offset
    model = output / (entry['key'] + '.glb')
    bpy.ops.export_scene.gltf(filepath=str(model), export_format='GLB', export_yup=True, export_animations=False)
    return model, {'width_cm': math.ceil((upper.x - lower.x) * 100), 'depth_cm': math.ceil((upper.y - lower.y) * 100)}


# 制作清单保留源字节、许可和产物字节，正式发布目录由主集成人单独合并。
def main():
    parser = argparse.ArgumentParser(description=CONTENT['description'])
    parser.add_argument('--output', type=Path, default=ROOT / CONTENT['output_directory'])
    parser.add_argument('--only', choices=['cottage', 'courtyard', 'landscape', 'all'], default='all')
    parser.add_argument('--fetch-only', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    if args.fetch_only:
        fetch_sources()
        return
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / 'tiny-treats-manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'houses': [], 'assets': []}
    manifest['source_packs'] = json.loads(((ROOT / CONTENT['source_root']).parent / 'pack-manifest.json').read_text())['packs']
    selected = CONTENT['houses'] if args.only == 'all' else [item for item in CONTENT['houses'] if args.only in item['house_key']]
    for variant in selected:
        model, geometry = prepare_house(variant, args.output)
        manifest['houses'] = [item for item in manifest['houses'] if item['house_key'] != geometry['house_key']] + [geometry]
        entry = dict(key=variant['house_key'], name=variant['name'], pack_key='homely-house', kind='model', format='glb', url=geometry['model_url'], coin_price=variant['coin_price'], diamond_price=0)
        entry.update(source_sha256=hashlib.sha256(source_model('homely-house', 'house').read_bytes()).hexdigest())
        entry.update(provider='tiny-treats', source_url=CONTENT['source_urls']['homely-house'], license=CONTENT['license'], output_sha256=hashlib.sha256(model.read_bytes()).hexdigest())
        manifest['assets'] = [item for item in manifest['assets'] if item['key'] != entry['key']] + [entry]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        print('房屋制作完成', entry['key'], flush=True)
    if args.only in ('all', 'landscape'):
        for entry in CONTENT['landscape_models']:
            model, footprint = prepare_landscape(entry, args.output)
            asset = dict(key=entry['key'], name=entry['name'], pack_key=entry['pack'], provider='tiny-treats', kind='model', format='glb', url='/api/v1/assets/' + entry['key'], source_url=CONTENT['source_urls'][entry['pack']], license=CONTENT['license'], output_sha256=hashlib.sha256(model.read_bytes()).hexdigest(), obstacle_cm=entry['obstacle_cm'], footprint=footprint, blocks_placement=entry.get('blocks_placement', True))
            manifest['assets'] = [item for item in manifest['assets'] if item['key'] != asset['key']] + [asset]
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
            print('景物制作完成', asset['key'], flush=True)


if __name__ == '__main__':
    main()
