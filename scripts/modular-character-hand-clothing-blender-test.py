"""使用真实来源与prepare提取函数，检查fit之前手衣完整、材质与原蒙皮保留且裸手被排除。"""
import argparse
import ast
from array import array
from collections import Counter
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


# 全部图像像素与真实材质参数共同参与比对，首角颜色相同不足以证明材质保持。
def material_signature(material, images):
    image_records, shader_records, links = [], [], []
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image:
                image = node.image
                if image not in images:
                    digest = hashlib.sha256(array('f', image.pixels[:]).tobytes()).hexdigest()
                    images[image] = (tuple(image.size), image.channels, image.colorspace_settings.name, image.alpha_mode, digest)
                image_records.append((node.name, node.interpolation, node.extension, images[image]))
            if node.type == 'BSDF_PRINCIPLED':
                values = []
                for name in ['Base Color', 'Metallic', 'Roughness', 'Alpha', 'Emission Color', 'Emission Strength']:
                    socket = node.inputs.get(name)
                    if socket is not None:
                        value = socket.default_value
                        values.append((name, tuple(value) if hasattr(value, '__len__') else float(value), socket.is_linked))
                shader_records.append((node.name, tuple(values)))
        links = [(link.from_node.name, link.from_socket.name, link.to_node.name, link.to_socket.name)
                 for link in material.node_tree.links]
    return (material.name, tuple(material.diffuse_color), material.metallic, material.roughness,
            material.use_backface_culling, tuple(sorted(image_records)), tuple(sorted(shader_records)), tuple(sorted(links)))


# 逐三角保留顶点、UV、材质实际颜色与骨骼权重，网格数量不能证明没有漏手套。
def signatures(obj, polygons=None):
    mesh = obj.data
    mesh.calc_loop_triangles()
    uv = mesh.uv_layers.active
    names = {group.index: group.name for group in obj.vertex_groups}
    records = Counter()
    materials, images = {}, {}
    for triangle in mesh.loop_triangles:
        if polygons is not None and triangle.polygon_index not in polygons:
            continue
        material = mesh.materials[mesh.polygons[triangle.polygon_index].material_index]
        image = next((node.image for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image), None) if material.use_nodes else None
        vertices = []
        for vertex_index, loop_index in zip(triangle.vertices, triangle.loops):
            vertex = mesh.vertices[vertex_index]
            coordinate = tuple(obj.matrix_world @ vertex.co)
            texture = tuple(uv.data[loop_index].uv) if uv else ()
            weights = tuple(sorted((names[group.group], group.weight) for group in vertex.groups if group.weight > .00001))
            vertices.append((coordinate, texture, weights))
        if image and uv:
            sample = uv.data[triangle.loops[0]].uv
            x = min(image.size[0] - 1, max(0, int(sample.x * image.size[0])))
            y = min(image.size[1] - 1, max(0, int(sample.y * image.size[1])))
            offset = (y * image.size[0] + x) * image.channels
            color = tuple(round(value, 4) for value in image.pixels[offset:offset + 3])
        else:
            color = tuple(round(value, 4) for value in material.diffuse_color[:3])
        if material not in materials:
            materials[material] = material_signature(material, images)
        records[(tuple(sorted(vertices)), (materials[material], color))] += 1
    return records


# 坐标、UV与同名骨骼权重共同证明同一顶点，容差仅容纳GLB浮点尾差。
def same_vertex(first, second):
    coordinate, uv, weights = first
    other_coordinate, other_uv, other_weights = second
    if any(abs(a - b) > .000002 for a, b in zip(coordinate, other_coordinate)):
        return False
    if len(uv) != len(other_uv) or any(abs(a - b) > .000002 for a, b in zip(uv, other_uv)):
        return False
    weights, other_weights = dict(weights), dict(other_weights)
    if weights.keys() != other_weights.keys():
        return False
    return all(abs(weight - other_weights[bone]) <= .00002 for bone, weight in weights.items())


# GLB重序列化允许浮点尾差，按真实顶点邻近比较而非用四舍五入制造假丢面。
def missing_triangles(expected, actual):
    cell_size = .0001
    buckets = {}
    for triangle in actual:
        center = tuple(sum(vertex[0][axis] for vertex in triangle[0]) / 3 for axis in range(3))
        cell = tuple(math.floor(value / cell_size) for value in center)
        buckets.setdefault(cell, []).append(triangle)
    available = actual.copy()
    missing = 0
    for triangle, count in expected.items():
        center = tuple(sum(vertex[0][axis] for vertex in triangle[0]) / 3 for axis in range(3))
        cell = tuple(math.floor(value / cell_size) for value in center)
        candidates = [candidate for offset in itertools.product([-1, 0, 1], repeat=3) for candidate in buckets.get(tuple(a + b for a, b in zip(cell, offset)), [])]
        for _ in range(count):
            matched = None
            for candidate in candidates:
                if not available[candidate] or candidate[1] != triangle[1]:
                    continue
                unused = list(candidate[0])
                for vertex in triangle[0]:
                    found = next((index for index, other in enumerate(unused) if same_vertex(vertex, other)), None)
                    if found is None:
                        break
                    unused.pop(found)
                if not unused:
                    matched = candidate
                    break
            if matched is None:
                missing += 1
            else:
                available[matched] -= 1
    return missing


# 手套来源仅由已审核UV/材质判定，预处理产生的平面腕口封盖不属于原款表面。
def expected_hands(bpy, bmesh, module, source_key, declaration):
    from mathutils import Vector

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / declaration['path']))
    expected = Counter()
    expected_body = Counter()
    wrist = declaration['wrist_abs_x']
    for name in declaration['nodes']:
        obj = bpy.data.objects[name]
        # 原版1.0上臂含手套，按原制作腕线取外段但不制造封面。
        sign = 1 if sum(vertex.co.x for vertex in obj.data.vertices) >= 0 else -1
        points = [vertex.co for vertex in obj.data.vertices]
        if min(abs(point.x) for point in points) < wrist - .00001:
            mesh = bmesh.new()
            mesh.from_mesh(obj.data)
            bmesh.ops.bisect_plane(mesh, geom=list(mesh.verts) + list(mesh.edges) + list(mesh.faces), plane_co=Vector((sign * wrist, 0, 0)), plane_no=Vector((sign, 0, 0)), clear_inner=True, dist=.000001)
            bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
            mesh.to_mesh(obj.data)
            mesh.free()
        uv = obj.data.uv_layers.active
        keep = set()
        body = set()
        for polygon in obj.data.polygons:
            coordinate = tuple(sum(uv.data[index].uv[axis] for index in polygon.loop_indices) / len(polygon.loop_indices) for axis in range(2)) if uv else (0, 0)
            material = obj.data.materials[polygon.material_index].name
            cap = all(abs(abs(obj.data.vertices[index].co.x) - wrist) < .00001 for index in polygon.vertices)
            is_body = module.body_surface(source_key, material, coordinate) or any(low_u <= coordinate[0] <= high_u and low_v <= coordinate[1] <= high_v for low_u, high_u, low_v, high_v in declaration.get('body_uv_regions', []))
            if is_body and not cap:
                body.add(polygon.index)
            if not is_body and not cap:
                keep.add(polygon.index)
        expected.update(signatures(obj, keep))
        expected_body.update(signatures(obj, body))
    return expected, expected_body


# 直接编译prepare里的真实提取函数及依赖，不执行发布流程，也不复制一份提取算法。
def extraction_context(module, bpy, bmesh):
    from mathutils import Matrix, Vector

    tree = ast.parse(Path(module.__file__).read_text())
    prepare = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare')
    names = {'select', 'anatomical', 'open_wrist', 'hand_clothing'}
    functions = [node for node in prepare.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in functions} == names, 'prepare真实手部提取入口改变，需要同步测试调用边界'
    namespace = {**module.__dict__, 'bpy': bpy, 'bmesh': bmesh, 'Matrix': Matrix, 'Vector': Vector, 'rig': None}
    exec(compile(ast.Module(body=functions, type_ignores=[]), module.__file__, 'exec'), namespace)
    return namespace


# 重新导入完整源，避免预期计算时的腕线裁切提前替生产函数完成了工作。
def extracted_hands(bpy, context, source_key, declaration, change_part=None):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / declaration['path']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    context['rig'] = rig
    sources = {name: bpy.data.objects[name] for name in declaration['nodes']}
    actual = Counter()
    for index, source in enumerate(sources.values()):
        part = context['hand_clothing'](source, source_key, 'test_extracted_hand_' + str(index),
                                       declaration['wrist_abs_x'], declaration.get('body_uv_regions', []))
        if part is not None:
            if change_part is not None:
                change_part(part)
            actual.update(signatures(part))
    return actual


# 对真实含裸指来源故意关闭人体筛选，证明检查器能发现实际裸手泄漏。
def verify_body_leak_detection(bpy, context, fixture):
    source_key, declaration, body = fixture
    original = context['body_surface']
    try:
        context['body_surface'] = lambda source_key, material, uv: False
        actual = extracted_hands(bpy, context, source_key, declaration)
    finally:
        context['body_surface'] = original
    leaked = sum(body.values()) - missing_triangles(body, actual)
    assert leaked, '关闭人体筛选后仍未发现真实裸手泄漏，身体排除检查无效'
    print('真实裸手泄漏负例检查通过', source_key, leaked, flush=True)


# 在真实提取网格上删除面、改角点UV和材质，证明严格来源比对能实际拒绝损坏。
def verify_preservation_detection(bpy, bmesh, context, fixture):
    source_key, declaration, expected = fixture

    # 删除原手套的一张真实面。
    def remove_surface(part):
        mesh = bmesh.new()
        mesh.from_mesh(part.data)
        mesh.faces.ensure_lookup_table()
        bmesh.ops.delete(mesh, geom=[mesh.faces[0]], context='FACES')
        mesh.to_mesh(part.data)
        mesh.free()

    # 只改一张面的一角，不依赖整体UV或颜色发生大变化。
    def change_corner_uv(part):
        part.data.uv_layers.active.data[part.data.polygons[0].loop_indices[0]].uv.x += .01

    # 材质身份相同但参数改变也必须被发现。
    def change_diffuse(part):
        material = part.data.materials[part.data.polygons[0].material_index]
        material.diffuse_color[0] = (material.diffuse_color[0] + .25) % 1

    # 改首角采样之外的一个像素，验证检查器确实比较了完整图像。
    def change_other_image_pixel(part):
        face = part.data.polygons[0]
        material = part.data.materials[face.material_index]
        image = next(node.image for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image)
        uv = part.data.uv_layers.active.data[face.loop_indices[0]].uv
        x = min(image.size[0] - 1, max(0, int(uv.x * image.size[0])))
        y = min(image.size[1] - 1, max(0, int(uv.y * image.size[1])))
        sampled = (y * image.size[0] + x) * image.channels
        target = len(image.pixels) - image.channels
        target = 0 if target == sampled else target
        assert target != sampled, '真实图像不足以验证首角采样以外的像素'
        image.pixels[target] = (image.pixels[target] + .25) % 1
        image.update()

    for label, corruption in [('删除手套面', remove_surface), ('修改单角UV', change_corner_uv),
                              ('修改材质参数', change_diffuse), ('修改非首角图像像素', change_other_image_pixel)]:
        actual = extracted_hands(bpy, context, source_key, declaration, corruption)
        missing = missing_triangles(expected, actual)
        assert missing, label + '后仍未发现来源改变'
        print('真实来源保持负例检查通过', label, missing, flush=True)


# 目录只核对商品与别名存在；源面恢复在真实prepare提取之后、衣物fit之前严格比对。
def verify(catalog_path, asset_directory, recipe_path):
    import bpy
    import bmesh

    module_spec = importlib.util.spec_from_file_location('hand_clothing_source', ROOT / 'scripts/prepare-modular-characters.py')
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    context = extraction_context(module, bpy, bmesh)
    configuration = json.loads(recipe_path.read_text())
    catalog = json.loads(catalog_path.read_text())
    entries = {item['wearable_key']: item for item in catalog['wearables']}
    manifest_path = asset_directory.parent / 'provider-character-manifest.json'
    aliases = json.loads(manifest_path.read_text()).get('aliases', {})
    canonical = configuration['canonical_hand_sources']
    wrist = json.loads((ROOT / 'scripts/provider-character-sources.json').read_text())['seams']['wrist']
    cases = [(key, 'canonical', declaration) for key, declaration in canonical.items()]
    cases += [(source['key'] + '-upper', source['key'], {'path': source['normalized_model'], 'nodes': ['body_hands'], 'wrist_abs_x': wrist, 'body_uv_regions': source.get('hand_body_uv_regions', [])}) for source in configuration['sources']]
    failures = []
    checked = 0
    checked_body = 0
    body_fixture = None
    surface_fixture = None
    for key, source_key, declaration in cases:
        expected, body = expected_hands(bpy, bmesh, module, source_key, declaration)
        actual = extracted_hands(bpy, context, source_key, declaration)
        missing = missing_triangles(expected, actual)
        unexpected = missing_triangles(actual, expected)
        sold_body = sum(body.values()) - missing_triangles(body, actual)
        print('fit前手衣提取检查', key, '源衣物三角面', sum(expected.values()), '缺失', missing,
              '额外', unexpected, '混入裸手', sold_body, flush=True)
        if missing:
            failures.append(f'{key}: 提取时丢失或改变 {missing}/{sum(expected.values())} 个原手衣三角面（包括UV、材质、实际颜色与原权重）')
        if unexpected:
            failures.append(f'{key}: 提取时混入 {unexpected} 个非预期手衣三角面')
        if sold_body:
            failures.append(f'{key}: 裸手或骨骼的 {sold_body} 个三角面错误进入提取衣物')
        checked += bool(expected)
        checked_body += bool(body)
        if body_fixture is None and body and not declaration.get('body_uv_regions'):
            body_fixture = source_key, declaration, body
        if surface_fixture is None and expected:
            surface_fixture = source_key, declaration, expected
        resolved = key
        while resolved in aliases:
            resolved = aliases[resolved]
        item = entries.get(resolved)
        if item is None:
            if expected:
                failures.append(f'{key}: 对应上装不存在')
            else:
                print('手部衣物检查', key, '来源没有手部衣物且没有独立上装', flush=True)
    assert checked, '没有检查到实际手部衣物'
    assert checked_body, '没有核对任何真实裸手或骨骼，不能据此声称已排除身体表面'
    assert not failures, '\n'.join(failures)
    assert body_fixture is not None, '缺少可验证真实人体筛选的来源'
    verify_body_leak_detection(bpy, context, body_fixture)
    verify_preservation_detection(bpy, bmesh, context, surface_fixture)
    print('fit前手部衣物完整性与裸手排除检查通过', checked, '含身体来源', checked_body, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/character/character-catalog.json')
    parser.add_argument('--assets', type=Path, default=ROOT / 'internal/assets/builtin')
    parser.add_argument('--recipe', type=Path, default=ROOT / 'scripts/modular-character-sources.json')
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    options = parser.parse_args(args)
    verify(options.catalog, options.assets, options.recipe)
