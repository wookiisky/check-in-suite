"""把获授权的本地发型加工为 KayKit 头部穿戴，并在正式脸型与动作上检查。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
from xml.etree import ElementTree

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from character_catalog_source import load_character_catalog

SOURCE_CONFIG = ROOT / 'scripts/local-hairstyle-sources.json'
SAMPLING_CONFIG = ROOT / 'scripts/asset-pipeline-rules.json'
VIEWS = {
    'front': (0, -1, .04), 'back': (0, 1, .04), 'left': (-1, 0, .04),
    'right': (1, 0, .04), 'scalp': (.08, -.3, 1), 'thumbnail': (.64, -1, .27),
}
# 共享取样计划之外，补查带有实际头骨转角的跑步片段。
TURN_SAMPLE = {'motion': 'run', 'normalized_time': .30, 'views': ['front', 'right']}
# 源坐标以头顶向上、脸向前；卷发横向压缩后仍保留原来层次。
FIT_TRANSFORMS = {
    '08': ((.164, .141, .128), (0, -.078, 1.338)),
    '18': ((.165, .142, .129), (0, -.078, 1.344)),
    '19': ((.164, .138, .127), (0, -.082, 1.335)),
    '22': ((.166, .142, .130), (0, -.078, 1.342)),
    '36': ((.148, .138, .116), (0, -.082, 1.455)),
}


# 复用人物工具已实现的动作查找和渲染准备约定。
def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 只读取骨架或静态模型，按本次导入返回对象，避免 Blender 名称后缀污染身份。
def import_model(path):
    existing = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - existing
    rig = next(obj for obj in added if obj.type == 'ARMATURE')
    meshes = {obj.name.partition('.')[0]: obj for obj in added if obj.type == 'MESH'}
    return rig, meshes


# 在源文件中直接读取绑定姿势的顶点及每角 UV，绕过 Blender 版本的 COLLADA 支持差异。
def read_hair(path):
    document = ElementTree.parse(path)
    mesh = document.find('.//{*}mesh')
    skin = document.find('.//{*}skin')
    sources = {node.get('id'): node for node in mesh.findall('{*}source')}
    position_input = mesh.find('{*}vertices/{*}input[@semantic="POSITION"]')
    positions = read_vectors(sources[position_input.get('source')[1:]])
    triangles = mesh.find('{*}triangles')
    inputs = {entry.get('semantic'): entry for entry in triangles.findall('{*}input')}
    uv = read_vectors(sources[inputs['TEXCOORD'].get('source')[1:]])
    stride = max(int(entry.get('offset')) for entry in inputs.values()) + 1
    entries = list(map(int, triangles.find('{*}p').text.split()))
    position_indices = entries[int(inputs['VERTEX'].get('offset'))::stride]
    uv_indices = entries[int(inputs['TEXCOORD'].get('offset'))::stride]
    faces = [tuple(position_indices[index:index + 3]) for index in range(0, len(position_indices), 3)]
    bones = skin.find('{*}joints/{*}input[@semantic="JOINT"]').get('source')[1:]
    joint_names = skin.find(f'{{*}}source[@id="{bones}"]/{{*}}Name_array').text.split()
    if triangles.get('material') != 'mHair' or len(faces) != int(triangles.get('count')):
        raise ValueError(f'发型源网格结构不符 {path}')
    return positions, faces, [uv[index] for index in uv_indices], joint_names


# 使用源数组访问器的跨度，避免把 UV 当三维坐标读取。
def read_vectors(source):
    values = list(map(float, source.find('{*}float_array').text.split()))
    stride = int(source.find('{*}technique_common/{*}accessor').get('stride'))
    return [tuple(values[index:index + stride]) for index in range(0, len(values), stride)]


# 从 sRGB 色板取得 glTF 使用的线性底色。
def color_value(hex_code):
    channels = [int(hex_code[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return tuple(channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4
                 for channel in channels)


# 灰度贴图保留明暗与原 UV，换色只调整现有 GLB 材质底色。
def hair_material(number, texture, color):
    material = bpy.data.materials.new(f'dye_hair_local_{number}')
    material.use_nodes = True
    material.diffuse_color = (*color, 1)
    nodes = material.node_tree.nodes
    shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = .8
    image = nodes.new('ShaderNodeTexImage')
    image.image = bpy.data.images.load(str(texture), check_existing=True)
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    inputs = {socket.identifier: socket for socket in mix.inputs}
    inputs['Factor_Float'].default_value = 1
    inputs['B_Color'].default_value = (*color, 1)
    links = material.node_tree.links
    links.new(image.outputs['Color'], inputs['A_Color'])
    links.new(next(socket for socket in mix.outputs if socket.identifier == 'Result_Color'), shader.inputs['Base Color'])
    return material


# 统一源坐标的前向与高度，源头发的静止造型保留在原始顶点。
def fit_hair(number, positions, faces, reference_surfaces):
    (sx, sy, sz), offset = FIT_TRANSFORMS[number]
    points = [Vector((x * sx, -z * sy, y * sz)) + Vector(offset) for x, y, z in positions]
    if number == '19':
        # 让前方收口越过微笑脸眉峰，顶部尖束和两耳后的轮廓保持原位。
        for point in points:
            front_weight = min(1, max(0, (-point.y - .16) / .19))
            point.z += .077 * front_weight * max(0, 1 - abs(point.z - 1.80) / .26)
    center = Vector((0, -.034, 1.745))
    raw_tree = BVHTree.FromPolygons(points, faces, all_triangles=True)
    corrections = []
    fitted = []
    for point in points:
        delta = point - center
        radius = delta.length
        direction = delta.normalized()
        if radius < .001 or (point.y < -.32 and point.z < 1.83):
            fitted.append(point)
            continue
        # 从外向内取发壳与四脸头皮的最外表面；逐角扩开过紧处。
        origin = center + direction * 2
        _, _, _, distance = raw_tree.ray_cast(origin, -direction, 2)
        outer = max(radius, 2 - distance) if distance is not None else radius
        surfaces = reference_surfaces['head'] if point.y > .04 else reference_surfaces['scalp']
        hits = [tree.ray_cast(origin, -direction, 2)[3] for tree in surfaces]
        scalp = max((2 - hit for hit in hits if hit is not None), default=0)
        # 内部封边保持贴合，避免把本应在头内的三角面抬成外露头发。
        weight = max(0, (radius / outer - .6) / .4)
        margin = .026 if point.y > .04 else .018
        correction = min(.115, max(0, scalp + margin - outer)) * weight
        fitted_point = point + direction * correction
        if number == '36':
            # 原卷发壳中央有向下的内封边；仅抬中央内侧，让它离开两种身体的颈柱。
            neck_distance = math.hypot(fitted_point.x, fitted_point.y - .035)
            inner_weight = min(1, max(0, (.29 - neck_distance) / .09))
            fitted_point.z += max(0, 1.525 - fitted_point.z) * inner_weight
        fitted.append(fitted_point)
        corrections.append(correction)
    return fitted, {'scale': [sx, sy, sz], 'translation': offset, 'scalp_margin': .018, 'rear_margin': .026,
                    'front_lift_maximum': .077 if number == '19' else 0,
                    'inner_neck_clearance_height': 1.525 if number == '36' else None,
                    'maximum_radial_adjustment': max(corrections, default=0),
                    'radially_adjusted_vertices': sum(value > 1e-6 for value in corrections)}


# 只使用正式人物的 head 骨权重，保持导出的完整标准骨架及逆绑定矩阵。
def bind_hair(number, positions, faces, uv, material, rig):
    name = f'hair-local-{number}'
    mesh = bpy.data.meshes.new(name + '-mesh')
    mesh.from_pydata(positions, [], faces)
    mesh.update()
    mesh.materials.append(material)
    layer = mesh.uv_layers.new(name='UVMap')
    for loop, coordinate in zip(layer.data, uv, strict=True):
        loop.uv = coordinate[:2]
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.matrix_world = Matrix.Identity(4)
    obj.vertex_groups.new(name='head').add(list(range(len(mesh.vertices))), 1, 'REPLACE')
    obj.modifiers.new('CharacterRig', 'ARMATURE').object = rig
    return obj


# 只导出当前穿戴与标准骨架，不将任何人体或脸型网格带入素材。
def export_hair(path, rig, obj):
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True,
                              export_animations=False, export_skins=True, export_def_bones=False)


# 采样当前求值网格，检查头饰和躯干时只读取实际显示对象。
def surface(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(graph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    faces = [tuple(triangle.vertices) for triangle in mesh.loop_triangles]
    evaluated.to_mesh_clear()
    return points, faces


# 将不同材质网格合并为一棵检查树，不改动渲染对象。
def surface_tree(meshes):
    points, faces = [], []
    for obj in meshes:
        vertices, triangles = surface(obj)
        faces.extend(tuple(index + len(points) for index in triangle) for triangle in triangles)
        points.extend(vertices)
    return BVHTree.FromPolygons(points, faces, all_triangles=True)


# 建立复用的头部正交镜头，光源跟随当前画面中心。
def setup_camera():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    for property in scene.render.bl_rna.properties:
        if property.identifier.startswith('use_stamp'):
            setattr(scene.render, property.identifier, False)
    scene.world = bpy.data.worlds.new('HairPreviewWorld')
    scene.world.color = (.6, .6, .6)
    scene.view_settings.view_transform = 'Standard'
    data = bpy.data.cameras.new('HairPreview')
    data.type = 'ORTHO'
    camera = bpy.data.objects.new('HairPreview', data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    lights = []
    for label, direction, energy in [('Key', (3, -4, 6), 520), ('Fill', (-4, -1, 3), 250), ('Back', (0, 4, 5), 350)]:
        light_data = bpy.data.lights.new(label, 'AREA')
        light_data.energy = energy
        light_data.shape = 'DISK'
        light_data.size = 3
        light = bpy.data.objects.new(label, light_data)
        scene.collection.objects.link(light)
        lights.append((light, Vector(direction)))
    return camera, lights


# 仅显示当前组合，按求值头部取景并记录真实 PNG。
def render(path, visible, focus, view, camera, lights, size=160):
    scene = bpy.context.scene
    for obj in scene.objects:
        if obj.type == 'MESH':
            obj.hide_render = obj not in visible
    points = [point for obj in focus for point in surface(obj)[0]]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (low + high) / 2
    camera.data.ortho_scale = max(high - low) * 1.36
    camera.location = center + Vector(VIEWS[view]).normalized() * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    for light, direction in lights:
        light.location = center + direction * .55
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x = scene.render.resolution_y = size
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


# 把重新导入的成品和正式形象绑定到同一骨架，重现实际换装路径。
def rebind(obj, rig):
    transform = obj.matrix_world.copy()
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = transform
    for modifier in obj.modifiers:
        if modifier.type == 'ARMATURE':
            modifier.object = rig


# 记录真实静止、阅读和走路姿态的采样，以及头饰与受保护区域的几何碰撞。
def verify(output, body, bodies, face_models, hair_models, rig, assets, camera, lights):
    arm = load_module('local_hair_arm', 'verify-modular-character-arms.py')
    assembly = load_module('local_hair_assembly', 'verify-modular-character-appearance.py')
    hashes = {}
    samples = json.loads(SAMPLING_CONFIG.read_text())['sampling']['local_hairstyles']
    actions = arm.load_actions(bpy, body, hashes, assets, poses=[(sample['motion'], 0) for sample in [*samples, TURN_SAMPLE]])
    rest_positions = {key: surface(hair)[0] for key, hair in hair_models.items()}
    records = []
    turn_records = []
    for sample in [*samples, TURN_SAMPLE]:
        motion = sample['motion']
        frame = sample.get('frame', 0)
        if motion != 'rest' and 'normalized_time' in sample:
            definition = body['animations'][motion]
            action = actions[(definition['asset_key'], definition['clip'])]
            frame = assembly.sample_frame(action.frame_range, sample)
        arm.apply_pose(bpy, rig, body, actions, motion, frame)
        head = rig.pose.bones['head']
        head_transform = rig.matrix_world @ head.matrix @ head.bone.matrix_local.inverted() @ rig.matrix_world.inverted()
        head_angle = math.degrees(head.matrix_basis.to_quaternion().angle)
        binding_errors = {
            key: max((actual - head_transform @ rest).length
                     for actual, rest in zip(surface(hair)[0], rest_positions[key], strict=True))
            for key, hair in hair_models.items()
        }
        body_trees = {key: surface_tree(meshes) for key, meshes in bodies.items()}
        for face, face_objects in face_models:
            brows = [obj for obj in face_objects if obj.name.startswith('face_brows')]
            brow_tree = surface_tree(brows) if brows else None
            display_body = bodies['kaykit-medium-v1' if brows else 'kaykit-skeleton-v1']
            for key, hair in hair_models.items():
                hair_tree = surface_tree([hair])
                body_collisions = {key: len(hair_tree.overlap(tree)) for key, tree in body_trees.items()}
                collisions = {
                    'body': max(body_collisions.values()),
                    'body_by_character': body_collisions,
                    'brows': len(hair_tree.overlap(brow_tree)) if brow_tree else 0,
                }
                for view in sample['views']:
                    time = f'frame:{frame}' if 'frame' in sample else f"time:{sample['normalized_time']}"
                    coverage = f"{face['wearable_key']}:head:{key}@{view}@{motion}@{time}"
                    path = Path('review') / key / face['wearable_key'] / f'{motion}-{view}.png'
                    render(output / path, [hair, *face_objects, *display_body], [hair, *face_objects],
                           view, camera, lights)
                    target_records = turn_records if sample is TURN_SAMPLE else records
                    target_records.append({'coverage': coverage, 'file': path.as_posix(), 'evaluated_frame': frame,
                                           'sha256': hashlib.sha256((output / path).read_bytes()).hexdigest(),
                                           'intersections': collisions, 'head_rotation_degrees': head_angle,
                                           'maximum_binding_error': binding_errors[key]})
    return records, turn_records, hashes


# 改色仅修改重读后的发丝材质，保留默认色缩略图及正式 GLB。
def render_color_contrast(output, hair, face_objects, camera, lights, blue):
    material = hair.data.materials[0]
    multiply = next(node for node in material.node_tree.nodes if node.type == 'MIX' and node.blend_type == 'MULTIPLY')
    factor = next(socket for socket in multiply.inputs
                  if socket.identifier in ('A_Color', 'B_Color') and not socket.is_linked)
    original = tuple(factor.default_value)
    factor.default_value = (*blue, 1)
    path = Path('review') / hair.name / 'blue-front.png'
    render(output / path, [hair, *face_objects], [hair, *face_objects], 'front', camera, lights)
    factor.default_value = original
    return {'color_key': 'blue', 'file': path.as_posix(),
            'sha256': hashlib.sha256((output / path).read_bytes()).hexdigest()}


# 以正式目录里的具体资产为适配基准，生成独立候选与可核对的证据。
def prepare(options):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.threads_mode = 'FIXED'
    bpy.context.scene.render.threads = 4
    catalog = load_character_catalog(options.catalog)
    source_config = json.loads(SOURCE_CONFIG.read_text())
    default_color = source_config['default_color_key']
    color_config = json.loads((ROOT / 'internal/character/wearable-colors.json').read_text())
    colors = {item['key']: color_value(item['hex']) for item in color_config}
    body = catalog['characters'][0]
    def load_asset(item):
        return options.assets / f"{item['model_asset_key']}.glb"

    rig, meshes = import_model(load_asset(body))
    rig.data.pose_position = 'REST'
    body_models = {body['character_key']: [meshes[name] for region in ('torso', 'arms')
                                          for name in body['body_regions'][region]]}
    face_models, reference_surfaces = [], {'head': [], 'scalp': []}
    input_assets = [load_asset(body)]
    for alternate in catalog['characters'][1:]:
        path = load_asset(alternate)
        alternate_rig, alternate_meshes = import_model(path)
        alternate_rig.data.pose_position = 'REST'
        objects = [alternate_meshes[name] for region in ('torso', 'arms')
                   for name in alternate['body_regions'][region]]
        for obj in objects:
            rebind(obj, rig)
        body_models[alternate['character_key']] = objects
        input_assets.append(path)
    for face in [entry for entry in catalog['wearables'] if entry['slot'] == 'face']:
        path = load_asset(face)
        face_rig, face_meshes = import_model(path)
        face_rig.data.pose_position = 'REST'
        objects = [face_meshes[node] for node in face['nodes']]
        for obj in objects:
            rebind(obj, rig)
        face_models.append((face, objects))
        reference_surfaces['head'].append(surface_tree([face_meshes[node] for node in ('face_head', 'face_scalp')]))
        reference_surfaces['scalp'].append(surface_tree([face_meshes['face_scalp']]))
        input_assets.append(path)
    camera, lights = setup_camera()
    styles = {}
    hair_models = {}
    for number in source_config['styles']:
        name = f'PlayerHair{number}'
        directory = options.source_root / f'{name}.Nin_NX_NVN'
        source, texture = directory / f'{name}.dae', directory / 'mHair_AlbGry.png'
        raw, faces, uv, joints = read_hair(source)
        positions, fit = fit_hair(number, raw, faces, reference_surfaces)
        material = hair_material(number, texture, colors[default_color])
        obj = bind_hair(number, positions, faces, uv, material, rig)
        key = obj.name
        model = options.output / f'{key}.glb'
        export_hair(model, rig, obj)
        bpy.data.objects.remove(obj, do_unlink=True)
        _, model_meshes = import_model(model)
        hair = model_meshes[key]
        rebind(hair, rig)
        hair_models[key] = hair
        thumbnail = options.output / f'{key}.png'
        render(thumbnail, [hair], [hair], 'thumbnail', camera, lights, size=256)
        contrast = render_color_contrast(options.output, hair, face_models[0][1], camera, lights, colors['blue'])
        styles[key] = {'wearable_key': key, 'node': key, 'material': material.name,
                       'default_color_key': default_color, 'covers': [],
                       'source': source.relative_to(options.source_root).as_posix(),
                       'texture': texture.relative_to(options.source_root).as_posix(),
                       'source_joints': joints, 'triangle_count': len(faces), 'fit': fit,
                       'target_bone': 'head', 'model': model.name, 'thumbnail': thumbnail.name, 'contrast': contrast,
                       'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                       'texture_sha256': hashlib.sha256(texture.read_bytes()).hexdigest(),
                       'model_sha256': hashlib.sha256(model.read_bytes()).hexdigest(),
                       'thumbnail_sha256': hashlib.sha256(thumbnail.read_bytes()).hexdigest()}
    records, turns, action_hashes = verify(options.output, body, body_models, face_models, hair_models,
                                          rig, options.assets, camera, lights)
    report = {'hairstyles': styles, 'views': records, 'coverage': [record['coverage'] for record in records],
              'turn_views': turns,
              'reference_sha256': {path.stem: hashlib.sha256(path.read_bytes()).hexdigest() for path in input_assets},
              'action_sha256': action_hashes, 'blender_version': bpy.app.version_string,
              'visual_review': 'pending'}
    (options.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if any(record['intersections']['body'] or record['intersections']['brows'] or record['maximum_binding_error'] > 1e-5
           for record in [*records, *turns]) or any(record['head_rotation_degrees'] < 10 for record in turns):
        raise ValueError('发型适配检查未通过，详见 report.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/character/character-catalog.json')
    parser.add_argument('--assets', type=Path, default=ROOT / 'internal/assets/builtin')
    options = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    for option in ('source_root', 'output', 'catalog', 'assets'):
        setattr(options, option, getattr(options, option).resolve())
    options.output.mkdir(parents=True, exist_ok=True)
    prepare(options)
