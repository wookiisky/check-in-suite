"""用真实原包和标准化 GLB 核对旧版衣物完整保留，需在 Blender 中运行。"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


# 保存真实头骨表面，重置 Blender 场景后仍可对照交付文件。
def head_surface(objects):
    from mathutils.bvhtree import BVHTree

    points, faces, samples = [], [], []
    for obj in objects:
        offset = len(points)
        points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        obj.data.calc_loop_triangles()
        for triangle in obj.data.loop_triangles:
            indices = tuple(offset + index for index in triangle.vertices)
            faces.append(indices)
            samples.append(sum((points[index] for index in indices), points[indices[0]] * 0) / 3)
    return BVHTree.FromPolygons(points, faces, all_triangles=True), points, samples


# 完整源头骨的每个表面都必须归入脸或头皮，不能叠入额外的通用支撑球。
def verify_head_surfaces(expected, actual, key):
    original, _, source_samples = expected
    delivered, vertices, _ = head_surface(actual)
    assert all(delivered.find_nearest(point)[3] < .00002 for point in source_samples), key + ': 完整源头骨表面缺失或被压缩'
    assert all(original.find_nearest(point)[3] < .00002 for point in vertices), key + ': 头皮混入源头骨之外的支撑球'


# 三角面带实际材质颜色参与对照，避免只凭非空网格或面数认定衣物完整。
def clothing_triangles(objects):
    result = Counter()
    for obj in objects:
        obj.data.calc_loop_triangles()
        for triangle in obj.data.loop_triangles:
            material = obj.data.materials[triangle.material_index]
            if material.name.split('.')[0] in ['White', 'Black']:
                continue
            color = tuple(round(value, 4) for value in material.diffuse_color)
            points = tuple(sorted(tuple(round(value, 6) for value in obj.data.vertices[index].co) for index in triangle.vertices))
            result[(points, color)] += 1
    return result


# GLB 使用浮点数存储，允许坐标舍入误差，但不能把不同表面当作同一三角面。
def unmatched_triangles(expected, actual):
    missing = list((expected - actual).elements())
    unexpected = list((actual - expected).elements())
    unmatched = []
    for points, color in missing:
        for index, (candidate, candidate_color) in enumerate(unexpected):
            if candidate_color == color and all(any(max(abs(a - b) for a, b in zip(point, other)) < .00001 for other in candidate) for point in points):
                unexpected.pop(index)
                break
        else:
            unmatched.append((points, color))
    return unmatched, unexpected


# 验收直接读取两种正式身体表面，不用加工器自己的包络声明证明适配。
def body_envelopes(bpy):
    from mathutils.bvhtree import BVHTree

    catalog = json.loads((ROOT / 'internal/character/character-catalog.json').read_text())
    result = {}
    for body in catalog['characters']:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin' / (body['model_asset_key'] + '.glb')))
        points, faces = [], []
        for obj in bpy.data.objects:
            if obj.type != 'MESH' or obj.name not in body['body_regions']['torso']:
                continue
            offset = len(points)
            points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
            faces.extend(tuple(offset + index for index in face.vertices) for face in obj.data.polygons)
        result[body['character_key']] = BVHTree.FromPolygons(points, faces)
    return result


# 开襟衣物保留身体可见，但真实衣片必须位于两种身体的表面之外。
def verify_torso_clearance(source_key, garment, envelopes):
    from mathutils import Vector

    for body_key, tree in envelopes.items():
        hidden, checked = 0, 0
        garment.data.calc_loop_triangles()
        samples = [vertex.co.copy() for vertex in garment.data.vertices]
        for triangle in garment.data.loop_triangles:
            vertices = [garment.data.vertices[index].co for index in triangle.vertices]
            samples.append(sum(vertices, Vector((0, 0, 0))) / 3)
            samples.extend((vertices[index] + vertices[(index + 1) % 3]) / 2 for index in range(3))
        for sample in samples:
            point = garment.matrix_world @ sample
            if abs(point.x) > .38:
                continue
            direction = Vector((point.x, point.y, 0)).normalized()
            hit = tree.ray_cast(Vector((direction.x * 3, direction.y * 3, point.z)), -direction, 6)[0]
            if hit is None or hit.dot(direction) <= 0:
                continue
            checked += 1
            if hit.xy.length > point.xy.length + .001:
                hidden += 1
        assert hidden == 0, f'{source_key}: {body_key} 躯干遮住 {hidden}/{checked} 个衣片表面采样点'


# 同一高度和方向的内外层使用相同位移，真实双层网格不能被压成零厚度。
def verify_shell_thickness(bpy, bmesh, binding, recipe):
    import math

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / recipe['canonical_input']['path']))
    canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    positions = [(radius * math.cos(angle), radius * math.sin(angle), height)
                 for radius in [.10, .14] for height in [.85, .95] for angle in [-math.pi / 4, math.pi / 4]]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6)]
    mesh = bpy.data.meshes.new('open_shell_test_mesh')
    mesh.from_pydata(positions, [], faces)
    obj = bpy.data.objects.new('open_shell_test', mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(bpy.data.materials.new('Test_Clothing'))
    obj.vertex_groups.new(name='chest').add(list(range(8)), 1, 'REPLACE')
    configuration = next(source['spec']['torso_clothing_fit'] for source in recipe['sources'] if source['spec'].get('torso_clothing_fit'))
    binding.fit_torso_clothing(bpy, bmesh, [obj], canonical, configuration)
    assert [tuple(face.vertices) for face in mesh.polygons] == faces, '包络适配改变了衣片开口或拓扑'
    for index in range(4):
        assert abs(mesh.vertices[index + 4].co.xy.length - mesh.vertices[index].co.xy.length - .04) < .00001, '包络适配压扁了衣物内外层'
    assert all(abs(vertex.co.z - positions[index][2]) < .000001 for index, vertex in enumerate(mesh.vertices)), '包络适配改变了衣物自然高度'
    assert all(len(vertex.groups) == 1 and vertex.groups[0].weight == 1 for vertex in mesh.vertices), '包络适配改变了已有蒙皮'


# 原始服装只做已审核拟合；与最终独立衣物逐面比对，不沿用上游加工声明。
def verify(input_directory=None):
    import bpy
    import bmesh

    specification = importlib.util.spec_from_file_location('legacy_clothing_binding', ROOT / 'scripts/provider-character-binding.py')
    binding = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(binding)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    envelopes = body_envelopes(bpy)
    verify_shell_thickness(bpy, bmesh, binding, recipe)
    seams = json.loads((ROOT / 'scripts/provider-character-sources.json').read_text())['seams']
    for source in recipe['sources']:
        if not source['spec'].get('requires_standard_body_augmentation'):
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / recipe['canonical_input']['path']))
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        for obj in canonical.values():
            obj.name = '_canonical_' + obj.name
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / source['source']))
        imported = set(bpy.data.objects) - before
        # 这四个源头骨完整，预期始终适配完整头部，不能由待验证配方降低预期高度。
        parts, fitted, _ = binding.bind_parts(bpy, bmesh, rig, imported, {**source['spec'], 'partition_scalp': True}, canonical)
        fields = ['body_nodes', 'left_arm_nodes', 'right_arm_nodes', 'left_leg_nodes', 'right_leg_nodes']
        expected = clothing_triangles([parts[name] for field in fields for name in fitted.get(field, [])])
        expected_head = head_surface([parts[name] for name in fitted['head_nodes']])
        assert expected, source['key'] + ': 原包没有可比对衣物'
        bpy.ops.wm.read_factory_settings(use_empty=True)
        path = input_directory / (source['key'] + '.glb') if input_directory else ROOT / source['normalized_model']
        bpy.ops.import_scene.gltf(filepath=str(path))
        meshes = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        verify_head_surfaces(expected_head, [meshes['body_head'], meshes['body_scalp']], source['key'])
        assert 'upper_native' in meshes and 'lower_native' in meshes, source['key'] + ': 缺少完整原生衣物节点'
        lower_points = [vertex.co for vertex in meshes['lower_native'].data.vertices]
        assert min(point.z for point in lower_points) < seams['waist'], source['key'] + ': 腰带下段未保留'
        assert max(point.z for point in lower_points) <= source['spec']['native_waist_accessory_top'] + .00001, source['key'] + ': 完整上衣被错误归入腰带'
        upper_points = [vertex.co for vertex in meshes['upper_native'].data.vertices]
        assert min(point.x for point in upper_points) < -seams['wrist'] and max(point.x for point in upper_points) > seams['wrist'], source['key'] + ': 左右腕部配件被裁断'
        verify_torso_clearance(source['key'], meshes['upper_native'], envelopes)
        actual = clothing_triangles([meshes['upper_native'], meshes['lower_native']])
        missing, unexpected = unmatched_triangles(expected, actual)
        assert not missing, f"{source['key']}: 原生衣物缺少 {len(missing)} 个真实三角面"
        assert not unexpected, f"{source['key']}: 原生衣物多出 {len(unexpected)} 个真实三角面"
        assert all(sum(group.weight for group in vertex.groups) > .999 for name in ['upper_native', 'lower_native'] for vertex in meshes[name].data.vertices), source['key'] + ': 衣物蒙皮不完整'
        print('LEGACY_CLOTHING_COMPLETE', source['key'], sum(actual.values()), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-directory', type=Path)
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    verify(parser.parse_args(args).input_directory)
