"""43 款独立发型批量转换与姿态采样渲染脚本（运行在 Blender 中）。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from character_catalog_source import load_character_catalog

SOURCE_ROOT = Path('/Users/air/Downloads/Model')
VIEWS = {
    'front': (0, -1, .04), 'back': (0, 1, .04), 'left': (-1, 0, .04),
    'right': (1, 0, .04), 'scalp': (.08, -.3, 1), 'thumbnail': (.64, -1, .27),
}
TURN_SAMPLE = {'motion': 'run', 'normalized_time': .30, 'views': ['front', 'right']}

HAIRSTYLE_DEFINITIONS = {
    '00': {'name': '刘海单马尾', 'type': 'gray', 'dae': 'PlayerHair00.Nin_NX_NVN/PlayerHair00.dae', 'tex': 'mHair_AlbGry.png'},
    '01': {'name': '双扎短发', 'type': 'gray', 'dae': 'PlayerHair01.Nin_NX_NVN/PlayerHair01.dae', 'tex': 'mHair_AlbGry.png'},
    '02': {'name': '中分自然发', 'type': 'gray', 'dae': 'PlayerHair02.Nin_NX_NVN/PlayerHair02.dae', 'tex': 'mHair_AlbGry.png'},
    '03': {'name': '顺滑短发', 'type': 'gray', 'dae': 'PlayerHair03.Nin_NX_NVN/PlayerHair03.dae', 'tex': 'mHair_AlbGry.png'},
    '04': {'name': '双马尾长辫', 'type': 'gray_braid', 'dae': 'PlayerHair04.Nin_NX_NVN/PlayerHair04.dae', 'tex': 'mHair_AlbGry.png'},
    '05': {'name': '侧马尾微卷发', 'type': 'gray', 'dae': 'PlayerHair05.Nin_NX_NVN/PlayerHair05.dae', 'tex': 'mHair_AlbGry.png'},
    '06': {'name': '层次及肩发', 'type': 'gray', 'dae': 'PlayerHair06.Nin_NX_NVN/PlayerHair06.dae', 'tex': 'mHair_AlbGry.png'},
    '07': {'name': '经典及肩长发', 'type': 'gray_braid', 'dae': 'PlayerHair07.Nin_NX_NVN/PlayerHair07.dae', 'tex': 'mHair_AlbGry.png'},
    '09': {'name': '随性短发', 'type': 'gray', 'dae': 'PlayerHair09.Nin_NX_NVN/PlayerHair09.dae', 'tex': 'mHair_AlbGry.png'},
    '10': {'name': '垂肩长发', 'type': 'gray_braid', 'dae': 'PlayerHair10.Nin_NX_NVN/PlayerHair10.dae', 'tex': 'mHair_AlbGry.png'},
    '11': {'name': '齐刘海中长发', 'type': 'gray_braid', 'dae': 'PlayerHair11.Nin_NX_NVN/PlayerHair11.dae', 'tex': 'mHair_AlbGry.png'},
    '12': {'name': '高马尾发型', 'type': 'gray', 'dae': 'PlayerHair12.Nin_NX_NVN/PlayerHair12.dae', 'tex': 'mHair_AlbGry.png'},
    '13': {'name': '清爽短发', 'type': 'gray', 'dae': 'PlayerHair13.Nin_NX_NVN/PlayerHair13.dae', 'tex': 'mHair_AlbGry.png'},
    '14': {'name': '波浪短发', 'type': 'gray', 'dae': 'PlayerHair14.Nin_NX_NVN/PlayerHair14.dae', 'tex': 'mHair_AlbGry.png'},
    '15': {'name': '双丸子短马尾', 'type': 'gray', 'dae': 'PlayerHair15.Nin_NX_NVN/PlayerHair15.dae', 'tex': 'mHair_AlbGry.png'},
    '16': {'name': '蓬松双马尾', 'type': 'gray', 'dae': 'PlayerHair16.Nin_NX_NVN/PlayerHair16.dae', 'tex': 'mHair_AlbGry.png'},
    '17': {'name': '圆寸短发', 'type': 'gray', 'dae': 'PlayerHair17.Nin_NX_NVN/PlayerHair17.dae', 'tex': 'mHair_AlbGry.png'},
    '20': {'name': '侧梳短发', 'type': 'gray', 'dae': 'PlayerHair20.Nin_NX_NVN/PlayerHair20.dae', 'tex': 'mHair_AlbGry.png'},
    '21': {'name': '极简短发', 'type': 'gray', 'dae': 'PlayerHair21.Nin_NX_NVN/PlayerHair21.dae', 'tex': 'mHair_AlbGry.png'},
    '23': {'name': '铲青短发', 'type': 'dual', 'dae': 'PlayerHair23.Nin_NX_NVN/PlayerHair23.dae', 'tex': 'mHair_AlbGry.png'},
    '24': {'name': '渐变平头', 'type': 'dual', 'dae': 'PlayerHair24.Nin_NX_NVN/PlayerHair24.dae', 'tex': 'mHair_AlbGry.png'},
    '25': {'name': '渐变短碎发', 'type': 'dual', 'dae': 'PlayerHair25.Nin_NX_NVN/PlayerHair25.dae', 'tex': 'mHair_AlbGry.png'},
    '26': {'name': '铲青短卷发', 'type': 'dual', 'dae': 'PlayerHair26.Nin_NX_NVN/PlayerHair26.dae', 'tex': 'mHair_AlbGry.png'},
    '27': {'name': '短碎发双材质', 'type': 'dual', 'dae': 'PlayerHair27.Nin_NX_NVN/PlayerHair27.dae', 'tex': 'mHair_AlbGry.png'},
    '28': {'name': '铲青蓬松短发', 'type': 'dual', 'dae': 'PlayerHair28.Nin_NX_NVN/PlayerHair28.dae', 'tex': 'mHair_AlbGry.png'},
    '29': {'name': '双麻花长辫', 'type': 'gray_braid', 'dae': 'PlayerHair29.Nin_NX_NVN/PlayerHair29.dae', 'tex': 'mHair_AlbGry.png'},
    '30': {'name': '侧卷自然发', 'type': 'gray', 'dae': 'PlayerHair30.Nin_NX_NVN/PlayerHair30.dae', 'tex': 'mHair_AlbGry.png'},
    '31': {'name': '微寸发茬', 'type': 'gray', 'dae': 'PlayerHair31.Nin_NX_NVN/PlayerHair31.dae', 'tex': 'mHair_AlbGry.png'},
    '32': {'name': '渐变极短发', 'type': 'dual', 'dae': 'PlayerHair32.Nin_NX_NVN/PlayerHair32.dae', 'tex': 'mHair_AlbGry.png'},
    '33': {'name': '顶束小短辫', 'type': 'gray', 'dae': 'PlayerHair33.Nin_NX_NVN/PlayerHair33.dae', 'tex': 'mHair_AlbGry.png'},
    '34': {'name': '侧分发茬短发', 'type': 'scalp_low_alpha', 'dae': 'PlayerHair34.Nin_NX_NVN/PlayerHair34.dae', 'tex': 'mHairSkin_Alb.png'},
    '35': {'name': '寸头贴皮发', 'type': 'scalp_low_alpha', 'dae': 'PlayerHair35.Nin_NX_NVN/PlayerHair35.dae', 'tex': 'mHairSkin_Alb.png'},
    '37': {'name': '微翘双短发', 'type': 'gray', 'dae': 'PlayerHair37.Nin_NX_NVN/PlayerHair37.dae', 'tex': 'mHair_AlbGry.png'},
    '38': {'name': '齐刘海长直发', 'type': 'gray_braid', 'dae': 'PlayerHair38.Nin_NX_NVN/PlayerHair38.dae', 'tex': 'mHair_AlbGry.png'},
    '39': {'name': '斜刘海短发', 'type': 'gray', 'dae': 'PlayerHair39.Nin_NX_NVN/PlayerHair39.dae', 'tex': 'mHair_AlbGry.png'},
    '40': {'name': '波浪及肩卷发', 'type': 'gray_braid', 'dae': 'PlayerHair40.Nin_NX_NVN/PlayerHair40.dae', 'tex': 'mHair_AlbGry.png'},
    '41': {'name': '微卷层次短发', 'type': 'gray', 'dae': 'PlayerHair41.Nin_NX_NVN/PlayerHair41.dae', 'tex': 'mHair_AlbGry.png'},
    '42': {'name': '经典寸头发茬', 'type': 'scalp_color', 'dae': 'PlayerHair42.Nin_NX_NVN/PlayerHair42.dae', 'tex': 'mHairSkin_Alb.png'},
    '43': {'name': '束发小马尾', 'type': 'gray', 'dae': 'PlayerHair43.Nin_NX_NVN/PlayerHair43.dae', 'tex': 'mHair_AlbGry.png'},
    '44': {'name': '精致编发长辫', 'type': 'gray_braid', 'dae': 'PlayerHair44.Nin_NX_NVN/PlayerHair44.dae', 'tex': 'mHair_AlbGry.png'},
    '45': {'name': '顶束短发', 'type': 'scalp_gray', 'dae': 'PlayerHair45.Nin_NX_NVN/PlayerHair45.dae', 'tex': 'mHairSkin_AlbGry.png'},
    '46': {'name': '偏分层次短发', 'type': 'gray', 'dae': 'PlayerHair46.Nin_NX_NVN/PlayerHair46.dae', 'tex': 'mHair_AlbGry.png'},
    '47': {'name': '齐耳波波头', 'type': 'gray', 'dae': 'PlayerHair47.Nin_NX_NVN/PlayerHair47.dae', 'tex': 'mHair_AlbGry.png'},
}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def import_model(path):
    existing = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - existing
    rig = next(obj for obj in added if obj.type == 'ARMATURE')
    meshes = {obj.name.partition('.')[0]: obj for obj in added if obj.type == 'MESH'}
    return rig, meshes


def read_vectors(source):
    values = list(map(float, source.find('{*}float_array').text.split()))
    stride = int(source.find('{*}technique_common/{*}accessor').get('stride'))
    return [tuple(values[index:index + stride]) for index in range(0, len(values), stride)]


def parse_mesh_geometry(geom_node):
    mesh = geom_node.find('{*}mesh')
    sources = {node.get('id'): node for node in mesh.findall('{*}source')}
    pos_input = mesh.find('{*}vertices/{*}input[@semantic="POSITION"]')
    positions = read_vectors(sources[pos_input.get('source')[1:]])
    triangles = mesh.find('{*}triangles')
    inputs = {entry.get('semantic'): entry for entry in triangles.findall('{*}input')}
    uv = read_vectors(sources[inputs['TEXCOORD'].get('source')[1:]])
    stride = max(int(entry.get('offset')) for entry in inputs.values()) + 1
    entries = list(map(int, triangles.find('{*}p').text.split()))
    pos_indices = entries[int(inputs['VERTEX'].get('offset'))::stride]
    uv_indices = entries[int(inputs['TEXCOORD'].get('offset'))::stride]
    faces = [tuple(pos_indices[index:index + 3]) for index in range(0, len(pos_indices), 3)]
    return positions, faces, [uv[index] for index in uv_indices], triangles.get('material')


def read_hair_dae(path, hair_type):
    doc = ET.parse(path)
    geoms = {g.get('id'): g for g in doc.findall('.//{*}geometry')}
    if hair_type in ('gray', 'gray_braid'):
        target_geom = next(g for g in geoms.values() if 'mHair' in (g.get('id') or '') or 'Hair' in (g.get('id') or ''))
    elif hair_type == 'dual':
        target_geom = geoms.get('BodyHair__mHair-mesh') or next(g for g in geoms.values() if 'BodyHair' in (g.get('id') or ''))
    elif hair_type in ('scalp_low_alpha', 'scalp_color', 'scalp_gray'):
        target_geom = geoms.get('Hair__mHairSkin-mesh') or next(g for g in geoms.values() if 'HairSkin' in (g.get('id') or '') or 'mHairSkin' in (g.get('id') or ''))
    else:
        raise ValueError(f'未知发型类型：{hair_type}')

    positions, faces, uv, material_name = parse_mesh_geometry(target_geom)
    skin = doc.find('.//{*}skin')
    joint_names = ['Root']
    if skin is not None:
        bones = skin.find('{*}joints/{*}input[@semantic="JOINT"]')
        if bones is not None:
            source_id = bones.get('source')[1:]
            names = doc.find(f'.//{{*}}source[@id="{source_id}"]//{{*}}Name_array')
            if names is not None and names.text:
                joint_names = names.text.split()
    return positions, faces, uv, joint_names


def color_value(hex_code):
    channels = [int(hex_code[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return tuple(channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4
                 for channel in channels)


def build_hair_material(number, texture_path, color, is_scalp=False):
    material = bpy.data.materials.new(f'dye_hair_local_{number}')
    material.diffuse_color = (*color, 1)
    nodes = material.node_tree.nodes
    shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = .8
    image = nodes.new('ShaderNodeTexImage')
    image.image = bpy.data.images.load(str(texture_path), check_existing=True)
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    inputs = {socket.identifier: socket for socket in mix.inputs}
    inputs['Factor_Float'].default_value = 1
    inputs['B_Color'].default_value = (*color, 1)
    links = material.node_tree.links
    links.new(image.outputs['Color'], inputs['A_Color'])
    links.new(next(socket for socket in mix.outputs if socket.identifier == 'Result_Color'), shader.inputs['Base Color'])
    if is_scalp:
        links.new(image.outputs['Alpha'], shader.inputs['Alpha'])
    return material


def fit_hair_universal(number, hair_type, positions, faces, reference_surfaces):
    sx, sy, sz = (.165, .141, .129)
    tx, ty, tz = (0, -.078, 1.340)
    points = [Vector((x * sx, -z * sy, y * sz)) + Vector((tx, ty, tz)) for x, y, z in positions]

    center = Vector((0, -.034, 1.745))
    raw_tree = BVHTree.FromPolygons(points, faces, all_triangles=True)
    corrections = []
    fitted = []
    is_long_hair = hair_type == 'gray_braid'
    for point in points:
        delta = point - center
        radius = delta.length
        direction = delta.normalized()
        # 长发下垂部分（Z < 1.60）不向外辐射膨胀，避免向外炸开发尾
        if radius < .001 or (point.z < 1.60 and is_long_hair) or (point.y < -.32 and point.z < 1.83):
            fitted.append(point)
            continue
        origin = center + direction * 2
        _, _, _, distance = raw_tree.ray_cast(origin, -direction, 2)
        outer = max(radius, 2 - distance) if distance is not None else radius
        surfaces = reference_surfaces['head'] if point.y > .04 else reference_surfaces['scalp']
        hits = [tree.ray_cast(origin, -direction, 2)[3] for tree in surfaces]
        scalp = max((2 - hit for hit in hits if hit is not None), default=0)
        weight = max(0, (radius / outer - .6) / .4)
        margin = .026 if point.y > .04 else .018
        correction = min(.115, max(0, scalp + margin - outer)) * weight
        fitted_point = point + direction * correction
        fitted.append(fitted_point)
        corrections.append(correction)
    return fitted, {'scale': [sx, sy, sz], 'translation': [tx, ty, tz],
                    'maximum_radial_adjustment': max(corrections, default=0),
                    'radially_adjusted_vertices': sum(value > 1e-6 for value in corrections)}


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


def export_hair(path, rig, obj):
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True,
                              export_animations=False, export_skins=True, export_def_bones=False)


def surface(obj):
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(graph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    faces = [tuple(triangle.vertices) for triangle in mesh.loop_triangles]
    evaluated.to_mesh_clear()
    return points, faces


def surface_tree(meshes):
    points, faces = [], []
    for obj in meshes:
        vertices, triangles = surface(obj)
        faces.extend(tuple(index + len(points) for index in triangle) for triangle in triangles)
        points.extend(vertices)
    return BVHTree.FromPolygons(points, faces, all_triangles=True)


def setup_camera():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    for prop in scene.render.bl_rna.properties:
        if prop.identifier.startswith('use_stamp'):
            setattr(scene.render, prop.identifier, False)
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


def rebind(obj, rig):
    transform = obj.matrix_world.copy()
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = transform
    for modifier in obj.modifiers:
        if modifier.type == 'ARMATURE':
            modifier.object = rig


def render_color_contrast(output_dir, hair, face_objects, camera, lights, blue):
    material = hair.data.materials[0]
    multiply = next(node for node in material.node_tree.nodes if node.type == 'MIX' and node.blend_type == 'MULTIPLY')
    factor = next(socket for socket in multiply.inputs
                  if socket.identifier in ('A_Color', 'B_Color') and not socket.is_linked)
    original = tuple(factor.default_value)
    factor.default_value = (*blue, 1)
    path = output_dir / 'reviews' / hair.name / 'blue-front.png'
    render(path, [hair, *face_objects], [hair, *face_objects], 'front', camera, lights)
    factor.default_value = original
    return {'color_key': 'blue', 'file': path.as_posix(),
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def verify_hairstyles(output_dir, body, bodies, face_models, hair_models, rig, assets_path, camera, lights):
    arm = load_module('local_hair_arm', 'verify-modular-character-arms.py')
    assembly = load_module('local_hair_assembly', 'verify-modular-character-appearance.py')
    sampling_config = ROOT / 'scripts/asset-pipeline-rules.json'
    samples = json.loads(sampling_config.read_text())['sampling']['local_hairstyles']
    hashes = {}
    actions = arm.load_actions(bpy, body, hashes, assets_path, poses=[(s['motion'], 0) for s in [*samples, TURN_SAMPLE]])
    rest_positions = {key: surface(hair)[0] for key, hair in hair_models.items()}
    records = []
    turn_records = []
    body_trees = {key: surface_tree(meshes) for key, meshes in bodies.items()}

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

        # 仅选择第 1 款典型脸型（微笑脸）渲染动作采样与检测碰撞，避免 43 款 × 4 脸型产生爆炸的渲染耗时
        face, face_objects = face_models[0]
        brows = [obj for obj in face_objects if obj.name.startswith('face_brows')]
        brow_tree = surface_tree(brows) if brows else None
        display_body = bodies['kaykit-medium-v1']

        for key, hair in hair_models.items():
            hair_tree = surface_tree([hair])
            body_collisions = {k: len(hair_tree.overlap(tree)) for k, tree in body_trees.items()}
            collisions = {
                'body': max(body_collisions.values()),
                'body_by_character': body_collisions,
                'brows': len(hair_tree.overlap(brow_tree)) if brow_tree else 0,
            }
            for view in sample['views']:
                time_label = f'frame:{frame}' if 'frame' in sample else f"time:{sample['normalized_time']}"
                coverage = f"{face['wearable_key']}:head:{key}@{view}@{motion}@{time_label}"
                path = output_dir / 'reviews' / key / f'{motion}-{view}.png'
                render(path, [hair, *face_objects, *display_body], [hair, *face_objects], view, camera, lights)
                target_records = turn_records if sample is TURN_SAMPLE else records
                target_records.append({
                    'hair_key': key, 'coverage': coverage, 'file': path.as_posix(), 'evaluated_frame': frame,
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    'intersections': collisions, 'head_rotation_degrees': head_angle,
                    'maximum_binding_error': binding_errors[key],
                })
    return records, turn_records, hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--hairstyles', type=str, default='all', help='逗号分隔的发型编号，或者 all')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.threads_mode = 'FIXED'
    bpy.context.scene.render.threads = 4

    catalog = load_character_catalog(ROOT / 'internal/character/character-catalog.json')
    color_config = json.loads((ROOT / 'internal/character/wearable-colors.json').read_text())
    colors = {item['key']: color_value(item['hex']) for item in color_config}
    default_color = 'brown'

    body = catalog['characters'][0]
    def load_asset(item):
        return ROOT / 'internal/assets/builtin' / f"{item['model_asset_key']}.glb"

    rig, meshes = import_model(load_asset(body))
    rig.data.pose_position = 'REST'
    body_models = {body['character_key']: [meshes[name] for region in ('torso', 'arms')
                                          for name in body['body_regions'][region]]}
    face_models, reference_surfaces = [], {'head': [], 'scalp': []}
    for alternate in catalog['characters'][1:]:
        path = load_asset(alternate)
        alt_rig, alt_meshes = import_model(path)
        alt_rig.data.pose_position = 'REST'
        objects = [alt_meshes[name] for region in ('torso', 'arms') for name in alternate['body_regions'][region]]
        for obj in objects:
            rebind(obj, rig)
        body_models[alternate['character_key']] = objects

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

    camera, lights = setup_camera()
    styles = {}
    hair_models = {}

    models_dir = output_dir / 'models'
    thumbnails_dir = output_dir / 'thumbnails'
    models_dir.mkdir(parents=True, exist_ok=True)
    thumbnails_dir.mkdir(parents=True, exist_ok=True)

    target_keys = (
        list(HAIRSTYLE_DEFINITIONS.keys()) if args.hairstyles == 'all'
        else [k.strip() for k in args.hairstyles.split(',') if k.strip()]
    )

    print(f"开始批量转换 {len(target_keys)} 款发型...")
    for number in target_keys:
        meta = HAIRSTYLE_DEFINITIONS[number]
        source = SOURCE_ROOT / meta['dae']
        texture = SOURCE_ROOT / Path(meta['dae']).parent / meta['tex']
        print(f"[{number}] 转换 {meta['name']} (类型: {meta['type']})...")

        positions_raw, faces, uv, joints = read_hair_dae(source, meta['type'])
        positions, fit = fit_hair_universal(number, meta['type'], positions_raw, faces, reference_surfaces)
        is_scalp = meta['type'] in ('scalp_low_alpha', 'scalp_color', 'scalp_gray')
        material = build_hair_material(number, texture, colors[default_color], is_scalp=is_scalp)
        obj = bind_hair(number, positions, faces, uv, material, rig)
        key = obj.name
        model_path = models_dir / f'{key}.glb'
        export_hair(model_path, rig, obj)
        bpy.data.objects.remove(obj, do_unlink=True)

        _, model_meshes = import_model(model_path)
        hair = model_meshes[key]
        rebind(hair, rig)
        hair_models[key] = hair

        thumbnail_path = thumbnails_dir / f'{key}.png'
        render(thumbnail_path, [hair], [hair], 'thumbnail', camera, lights, size=256)
        contrast = render_color_contrast(output_dir, hair, face_models[0][1], camera, lights, colors['blue'])

        styles[key] = {
            'wearable_key': key, 'name': meta['name'], 'type': meta['type'],
            'material': material.name, 'source': meta['dae'], 'texture': (Path(meta['dae']).parent / meta['tex']).as_posix(),
            'triangle_count': len(faces), 'vertex_count': len(positions), 'fit': fit,
            'model': model_path.name, 'thumbnail': thumbnail_path.name,
            'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'texture_sha256': hashlib.sha256(texture.read_bytes()).hexdigest(),
            'model_sha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
            'thumbnail_sha256': hashlib.sha256(thumbnail_path.read_bytes()).hexdigest(),
            'contrast': contrast,
        }
        print(f"  ✓ 完成 {key} ({meta['name']}): 面数 {len(faces)}, 顶点数 {len(positions)}, 大小 {model_path.stat().st_size}B")

    print(f"开始姿态与动作采样验证...")
    records, turn_records, action_hashes = verify_hairstyles(
        output_dir, body, body_models, face_models, hair_models, rig, ROOT / 'internal/assets/builtin', camera, lights
    )

    report = {
        'hairstyles': styles,
        'views': records,
        'turn_views': turn_records,
        'action_sha256': action_hashes,
        'blender_version': bpy.app.version_string,
    }
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"批量转换与采样验证完成！产物已输出至 {output_dir}")


if __name__ == '__main__':
    main()
