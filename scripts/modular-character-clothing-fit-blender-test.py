"""用真实旧版服装验证完整部件小矩阵、原表面属性与显式刚性绑定。"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


# 用未适配的真实法师袍验证胸腹腿权重只转给hips，不改其他骨骼、网格与来源范围。
def verify_weight_remap():
    import bpy
    import bmesh

    # 测试使用实际prepare解剖提取；成品重绑后的权重不能再次充当原件夹具。
    def load(name, filename):
        specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    module = load('remap_clothing_fit', 'modular-character-clothing-fit.py')
    prepare = load('remap_actual_prepare', 'prepare-modular-characters.py')
    extraction = load('remap_source_extraction', 'modular-character-hand-clothing-blender-test.py')
    context = extraction.extraction_context(prepare, bpy, bmesh)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(source for source in recipe['sources'] if source['key'] == 'kaykit-adventurers-mage')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    context['rig'] = rig
    obj = context['anatomical'](bpy.data.objects['upper_provider'], source['key'], False, 'upper_outfit.001')
    assert obj.name == 'upper_outfit.001', '没有覆盖真实prepare尚未finish的点号节点'
    components = module.mesh_components(obj)
    selected = [component for component in components if len(component['faces']) in [628, 48]]
    assert {len(component['faces']) for component in selected} == {628, 48}, '缺少真实胸腹或腰扣来源'
    ids = {index for component in selected for index in component['vertices']}

    # 保存每个真实组，范围外以及未声明的组必须逐值不变。
    def weights():
        return [{obj.vertex_groups[group.group].name: group.weight for group in vertex.groups if group.weight > 0}
                for vertex in obj.data.vertices]

    before = weights()
    points = [vertex.co.copy() for vertex in obj.data.vertices]
    normals = [tuple(normal.vector) for normal in obj.data.corner_normals]
    properties = surface_properties(obj)
    names = ['upperleg.l', 'upperleg.r']
    affected = {index for index in ids if sum(before[index].get(name, 0) for name in names) > 0}
    assert affected and any(all(before[index].get(name, 0) > 0 for name in [*names, 'hips']) for index in affected), '没有覆盖两腿汇总到已有hips的真实点'
    adjustments = [{'selector': {'nodes': ['upper_outfit001'], 'bone_region': 'torso', 'face_count': count},
                    'weight_remap': {'upperleg.l': 'hips', 'upperleg.r': 'hips'}} for count in [628, 48]]
    report = module.fit_upper_clothing([obj], rig, adjustments)
    after = weights()
    for index, (old, new) in enumerate(zip(before, after)):
        if index not in ids:
            assert new == old, '权重映射改变了范围外披风或衣袖'
            continue
        assert not any(new.get(name, 0) for name in names), '胸腹仍被原大腿骨牵拉'
        assert abs(new.get('hips', 0) - old.get('hips', 0) - sum(old.get(name, 0) for name in names)) < .000001, '两腿权重没有等量叠加到已有hips'
        assert {name: value for name, value in new.items() if name not in [*names, 'hips']} == {name: value for name, value in old.items() if name not in [*names, 'hips']}, '权重映射重写了未声明的骨骼'
        assert abs(sum(old.values()) - sum(new.values())) < .000001, '权重映射改变了归一总和'
    assert sum(operation['remapped_vertices'] for operation in report['operations']) == len(affected), '实际重映射范围不符'
    assert all(vertex.co == point for vertex, point in zip(obj.data.vertices, points)) and surface_properties(obj) == properties, '纯权重映射改变了原位置、UV、面或材质'
    assert [tuple(normal.vector) for normal in obj.data.corner_normals] == normals, '纯权重映射改变了原法线'
    repeated = module.fit_upper_clothing([obj], rig, adjustments)
    assert weights() == after and all(vertex.co == point for vertex, point in zip(obj.data.vertices, points)), '重复权重映射继续改变了来源'
    assert not sum(operation['remapped_vertices'] for operation in repeated['operations']), '重复映射没有识别已完成的源权重'
    invalid = [{'selector': adjustments[0]['selector'], 'translation': [0, .01, 0]},
               {'selector': adjustments[1]['selector'], 'weight_remap': {'upperleg.l': 'missing_target_bone'}}]
    try:
        module.fit_upper_clothing([obj], rig, invalid)
    except ValueError as error:
        assert 'missing_target_bone' in str(error), '无效目标骨错误没有说明实际来源'
    else:
        raise AssertionError('无效目标骨未在任何修改前拒绝')
    assert weights() == after and all(vertex.co == point for vertex, point in zip(obj.data.vertices, points)), '无效目标骨被发现前已经部分修改衣物'
    print('真实法师袍局部权重映射与目标预检查通过', len(affected), '原点、法线与其余权重不变', flush=True)


# 真实兜帽衣片同时按X/Z淡出，保持披肩、袖根、源UV与蒙皮，法线由独立有限差分核验。
def verify_transform_weight_z():
    import bpy
    import bmesh
    from mathutils import Matrix, Vector

    # 调用实际来源解剖提取，不使用已经适配的成品反推夹具。
    def load(name, filename):
        specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    module = load('z_clothing_fit', 'modular-character-clothing-fit.py')
    prepare = load('z_actual_prepare', 'prepare-modular-characters.py')
    extraction = load('z_actual_extraction', 'modular-character-hand-clothing-blender-test.py')
    context = extraction.extraction_context(prepare, bpy, bmesh)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(source for source in recipe['sources'] if source['key'] == 'kaykit-adventurers-rogue-hooded')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    context['rig'] = rig
    obj = context['anatomical'](bpy.data.objects['upper_provider'], source['key'], False, 'upper_outfit.001')
    components = module.mesh_components(obj)
    assert any(len(component['faces']) == 348 for component in components), '真实披肩未保留为范围外对照'
    selected = [component for component in components if len(component['faces']) in [476, 94]]
    assert {len(component['faces']) for component in selected} == {476, 94}, '缺少真实下摆与扣件来源'
    ids = {index for component in selected for index in component['vertices']}
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    normals = [normal.vector.copy() for normal in obj.data.corner_normals]
    weights = [[(group.group, group.weight) for group in vertex.groups] for vertex in obj.data.vertices]
    properties = surface_properties(obj)
    snapshot = obj.data.copy()
    interior = next(points[index] for index in ids if .76 < points[index].z < .90 and .01 < abs(points[index].x) < .30)
    variants = [('旧X模式', None, [1, 0]), ('双轴模式', [.76, .90], [1, 0]),
                ('递减Z模式', [.90, .76], [1, 0]),
                ('固定X模式', [.76, .90], [1, 1]),
                ('Z下界夹点', [interior.z, interior.z + .14], [1, 0]),
                ('Z上界夹点', [interior.z - .14, interior.z], [1, 0])]
    checked_normals = 0
    for label, bounds, values in variants:
        obj.data = snapshot.copy()
        transition = {'from_abs_x': 0, 'to_abs_x': .32, 'values': values}
        if bounds is not None:
            transition['z_bounds'] = bounds
        adjustments = []
        for count in [476, 94]:
            component = next(component for component in selected if len(component['faces']) == count)
            side = '.l' if component['center'].x >= 0 else '.r'
            axis = module.arm_axis_at_x(rig, side, component['center'].x)
            adjustments.append({'selector': {'nodes': ['upper_outfit001'], 'bone_region': 'torso', 'face_count': count},
                'scale': [1.015 if values == [1, 1] else 1, 1.08, 1],
                'translation': [0, .08 * axis.y + .037, 0], 'transform_weight': transition})
        report = module.fit_upper_clothing([obj], rig, adjustments)
        assert report['operations'], '没有命中真实prepare点号节点'
        if bounds == [.76, .90]:
            for index, point in enumerate(points):
                if index not in ids or point.z >= .90 or (values == [1, 0] and abs(point.x) >= .32):
                    assert ((obj.matrix_world @ obj.data.vertices[index].co) - point).length < .000001, 'Z上界、原披肩或袖根被移动'
        assert surface_properties(obj) == properties, '双轴渐变改变了UV、面或材质'
        assert [[(group.group, group.weight) for group in vertex.groups] for vertex in obj.data.vertices] == weights, '双轴渐变改变了源权重'
        for operation in report['operations']:
            matrix = Matrix(operation['matrix'])
            indices = {index for component in selected
                       if len(component['faces']) == operation['selector']['face_count']
                       and (component['center'].x >= 0) == (operation['side'] == '.l') for index in component['vertices']}

            # 位置契约用Python双精度计算；法线从该位置函数作数值求导，不复写制作器的梯度公式。
            def mapped(point):
                amount = max(0, min(1, abs(point[0]) / .32))
                weight = values[0] + (values[1] - values[0]) * amount
                if bounds is not None:
                    weight *= max(0, min(1, (bounds[1] - point[2]) / (bounds[1] - bounds[0])))
                affine = [sum(float(matrix[row][column]) * point[column] for column in range(3)) + float(matrix[row][3]) for row in range(3)]
                return [point[row] + (affine[row] - point[row]) * weight for row in range(3)]

            for index in indices:
                expected = Vector(mapped(tuple(points[index])))
                assert ((obj.matrix_world @ obj.data.vertices[index].co) - expected).length < .000001, label + '的实际顶点不遵守轴向夹取边界'
                if bounds is None:
                    amount = max(0, min(1, abs(points[index].x) / .32))
                    legacy = points[index] + (matrix @ points[index] - points[index]) * (1 - amount)
                    assert (obj.matrix_world @ obj.data.vertices[index].co) == legacy, '未声明Z的旧X位置路径发生变化'
            for loop in obj.data.loops:
                if loop.vertex_index not in indices:
                    continue
                point = points[loop.vertex_index]
                if abs(point.x) < .001 or abs(abs(point.x) - .32) < .001:
                    continue
                if bounds is not None and any(abs(point.z - bound) < .001 for bound in bounds):
                    continue
                step = .00001
                columns = []
                for axis in range(3):
                    left, right = list(point), list(point)
                    left[axis] -= step
                    right[axis] += step
                    columns.append([(a - b) / (2 * step) for a, b in zip(mapped(right), mapped(left))])
                jacobian = Matrix(tuple(tuple(columns[column][row] for column in range(3)) for row in range(3)))
                local = obj.matrix_world.to_3x3().inverted() @ jacobian @ obj.matrix_world.to_3x3()
                expected = (local.inverted().transposed() @ normals[loop.index]).normalized()
                assert obj.data.corner_normals[loop.index].vector.dot(expected) > .9999, label + '的X/Z乘积法线不符合独立有限差分'
                checked_normals += 1
    assert checked_normals > 100, '没有实际检验到双轴法线'
    before_invalid = [vertex.co.copy() for vertex in obj.data.vertices]
    for invalid_bounds in [[.76, .76], [.76], [float('nan'), .90], [.76, float('inf')], [float('-inf'), .90]]:
        invalid = [{'selector': adjustments[0]['selector'], 'translation': [0, .01, 0]},
                   {'selector': adjustments[0]['selector'], 'transform_weight': {
                       'from_abs_x': 0, 'to_abs_x': .32, 'values': [1, 0], 'z_bounds': invalid_bounds}}]
        try:
            module.fit_upper_clothing([obj], rig, invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('无效Z范围未在任何修改前拒绝')
        assert all(vertex.co == point for vertex, point in zip(obj.data.vertices, before_invalid)), '无效Z范围被发现前已经部分修改衣物'
        assert surface_properties(obj) == properties, '拒绝无效Z范围时改变了原表面'
    print('真实兜帽衣片双轴夹取、披肩保护与有限差分法线检查通过', checked_normals, flush=True)


# 真实平面分别跨递增/递减区间与夹取端点，法线同时对照独立有限差分和实际面。
def verify_directional_z_transition_plane():
    import bpy
    import math
    from mathutils import Matrix, Vector

    specification = importlib.util.spec_from_file_location('directional_z_fit', ROOT/'scripts/modular-character-clothing-fit.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    for bounds in [[.96, 1.08], [1.08, .96]]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        armature = bpy.data.armatures.new('plane_rig_data')
        rig = bpy.data.objects.new('plane_rig', armature)
        bpy.context.collection.objects.link(rig)
        bpy.context.view_layer.objects.active = rig
        rig.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        for side, sign in [('l', 1), ('r', -1)]:
            for index, name in enumerate(['upperarm', 'lowerarm', 'wrist', 'hand']):
                bone = armature.edit_bones.new(name+'.'+side)
                bone.head = (sign*(.4+index*.2), 0, 1)
                bone.tail = (sign*(.5+index*.2), 0, 1)
        bpy.ops.object.mode_set(mode='OBJECT')
        vertices, faces = [], []
        for lower, upper in [[.93, .94], [.95, .96], [1.00, 1.04], [1.08, 1.09], [1.10, 1.11]]:
            start = len(vertices)
            vertices.extend([(.1, .02, lower), (.1, .02, upper), (.2, .02, upper), (.2, .02, lower)])
            faces.append(tuple(range(start, start+4)))
        mesh = bpy.data.meshes.new('directional_plane_mesh')
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(bpy.data.materials.new('PlaneSource'))
        obj = bpy.data.objects.new('directional_plane', mesh)
        bpy.context.collection.objects.link(obj)
        uv = mesh.uv_layers.new(name='UVMap')
        for loop in mesh.loops:
            point = mesh.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = (point.x, point.z)
        group = obj.vertex_groups.new(name='hips')
        group.add(list(range(len(vertices))), 1, 'REPLACE')
        mesh.update()
        points = [vertex.co.copy() for vertex in mesh.vertices]
        normals = [normal.vector.copy() for normal in mesh.corner_normals]
        properties = surface_properties(obj)
        weights = [[(group.group, group.weight) for group in vertex.groups] for vertex in mesh.vertices]
        adjustment = {'selector': {'nodes': [obj.name]}, 'translation': [0, .08, 0],
                      'transform_weight': {'from_abs_x': 0, 'to_abs_x': 1, 'values': [1, 1], 'z_bounds': bounds}}
        module.fit_upper_clothing([obj], rig, [adjustment])

        # 单独计算位置函数，不调用制作器的导数或变换实现。
        def mapped(point):
            weight = max(0, min(1, (bounds[1]-point[2])/(bounds[1]-bounds[0])))
            return [point[0], point[1]+.08*weight, point[2]]

        for vertex, point in zip(mesh.vertices, points):
            assert (vertex.co-Vector(mapped(point))).length < 1e-6, '递增/递减Z端点或clamp位置错误'
            assert all(math.isfinite(value) for value in vertex.co), '平面变换产生非有限位置'
        assert surface_properties(obj) == properties, 'Z方向切换改变了原UV、材质或拓扑'
        assert [[(group.group, group.weight) for group in vertex.groups] for vertex in mesh.vertices] == weights, 'Z方向切换改变了原权重'
        for loop in mesh.loops:
            point = points[loop.vertex_index]
            if min(abs(point.z-bound) for bound in bounds) < 1e-5:
                continue
            columns = []
            step = 1e-5
            for axis in range(3):
                left, right = list(point), list(point)
                left[axis] -= step
                right[axis] += step
                columns.append([(a-b)/(2*step) for a, b in zip(mapped(right), mapped(left))])
            jacobian = Matrix(tuple(tuple(columns[column][row] for column in range(3)) for row in range(3)))
            expected = (jacobian.inverted().transposed() @ normals[loop.index]).normalized()
            actual = mesh.corner_normals[loop.index].vector
            assert actual.dot(expected) > .99999, '递增/递减Z法线不符合独立有限差分'
            face = next(face for face in mesh.polygons if loop.index in face.loop_indices)
            assert actual.dot(face.normal) > .99999, '变换后法线与实际平面方向不一致'
        print('平面Z方向与clamp检查通过', bounds, len(mesh.vertices), len(mesh.loops), flush=True)
    before = [vertex.co.copy() for vertex in mesh.vertices]
    for invalid_bounds in [[1, 1], [float('nan'), 1], [1, float('inf')], [float('-inf'), 1]]:
        invalid = [{**adjustment, 'translation': [0, .01, 0]},
                   {**adjustment, 'transform_weight': {**adjustment['transform_weight'], 'z_bounds': invalid_bounds}}]
        try:
            module.fit_upper_clothing([obj], rig, invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('非有限或相等Z端点未被拒绝')
        assert all(vertex.co == point for vertex, point in zip(mesh.vertices, before)), '无效Z端点在拒绝前部分修改网格'


# 真实法师肩帽局部细分后贴合本轮人形肩臂，原UV、范围外和源面覆盖分别核验。
def verify_arm_surface_fit(catalog_path, assets):
    import bpy
    import bmesh
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.interpolate import poly_3d_calc

    def load(name, filename):
        specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    module = load('arm_surface_clothing', 'modular-character-clothing-fit.py')
    prepare = load('arm_surface_prepare', 'prepare-modular-characters.py')
    extraction = load('arm_surface_extraction', 'modular-character-hand-clothing-blender-test.py')
    context = extraction.extraction_context(prepare, bpy, bmesh)
    catalog = json.loads(catalog_path.read_text())
    human = next(body for body in catalog['characters'] if body['character_key'] == 'kaykit-medium-v1')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(assets / (human['model_asset_key'] + '.glb')))
    surface = module.capture_hand_surface(bpy.data.objects['body_arms'])
    # 只传纯数值，真正清空目标身体场景后再读源衣物。
    bpy.ops.wm.read_factory_settings(use_empty=True)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(source for source in recipe['sources'] if source['key'] == 'kaykit-adventurers-mage')
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    context['rig'] = rig
    obj = context['anatomical'](bpy.data.objects['upper_provider'], source['key'], False, 'upper_outfit.001')
    raw = obj.data.copy()
    selector = {'nodes': ['upper_outfit001'], 'bone_region': 'upperarm'}
    base = {'selector': selector, 'scale': [1, 1.3, 1.3], 'bind_bone': 'lowerarm', 'bind_from_bone': 'lowerarm'}
    module.fit_upper_clothing([obj], rig, [base])
    components = module.select_components(module.mesh_components(obj), selector, rig)
    vertices = {index for component in components for index in component['vertices']}
    source_faces = len(obj.data.polygons)
    # 独立BMesh参考只细分原表面，保留每个源三角编号和实际deform插值。
    reference = obj.data.copy()
    source_normals = {(face.index, tuple(round(value, 7) for value in obj.data.vertices[obj.data.loops[loop].vertex_index].co),
                       tuple(round(value, 7) for value in obj.data.uv_layers.active.data[loop].uv)): obj.data.corner_normals[loop].vector.copy()
                      for face in obj.data.polygons for loop in face.loop_indices}
    mesh = bmesh.new()
    mesh.from_mesh(reference)
    mesh.verts.ensure_lookup_table()
    mesh.edges.ensure_lookup_table()
    mesh.faces.ensure_lookup_table()
    parent_layer = mesh.faces.layers.int.new('_test_arm_parent')
    for face in mesh.faces:
        face[parent_layer] = face.index
    chosen = [face for face in mesh.faces if all(vertex.index in vertices and .12 < abs((obj.matrix_world @ vertex.co).x) < .45 for vertex in face.verts)
              and max((obj.matrix_world @ vertex.co).z for vertex in face.verts) > 1.17]
    assert len(chosen) == 42, '真实法师肩帽来源范围不符'
    edges = sorted({edge for face in chosen for edge in face.edges}, key=lambda edge: edge.index)
    bmesh.ops.subdivide_edges(mesh, edges=edges, cuts=1, use_grid_fill=True)
    mesh.to_mesh(reference)
    mesh.free()
    original_points = [obj.matrix_world @ vertex.co for vertex in reference.vertices]
    old_weights = [{obj.vertex_groups[group.group].name: group.weight for group in vertex.groups} for vertex in reference.vertices]
    parents = [value.value for value in reference.attributes['_test_arm_parent'].data]
    obj.data = raw.copy()
    settings = {'refine_abs_x': [.12, .45], 'refine_min_z': 1.17, 'subdivisions': 1,
                'fit_abs_x': [.30, .42], 'fit_z': [1.14, 1.20], 'offset': .003}
    arm = {'selector': selector, 'arm_surface_fit': settings}
    # 即使配方条目在矩阵之前，表面适配也必须在所有旧矩阵和绑定完成后执行。
    report = module.fit_upper_clothing([obj], rig, [arm, base], hand_surface={'arm_surface': surface})
    default = ([tuple(vertex.co) for vertex in obj.data.vertices], [tuple(normal.vector) for normal in obj.data.corner_normals],
               [[(group.group, group.weight) for group in vertex.groups] for vertex in obj.data.vertices])
    reference.calc_loop_triangles()
    positive = [tuple(triangle.vertices) for triangle in reference.loop_triangles
                if (reference.vertices[triangle.vertices[1]].co - reference.vertices[triangle.vertices[0]].co).cross(
                    reference.vertices[triangle.vertices[2]].co - reference.vertices[triangle.vertices[0]].co).length / 2 > 1e-12]

    # 常量UV不代表没有塌缩：直接以细分前源域的非零几何检查最终子面实际面积。
    def areas():
        return [(obj.data.vertices[b].co - obj.data.vertices[a].co).cross(obj.data.vertices[c].co - obj.data.vertices[a].co).length / 2
                for a, b, c in positive]

    collapsed_before = sum(area <= 1e-12 for area in areas())
    assert collapsed_before > 0, '真实源夹具没有重现全强度投影的正源域塌缩'
    obj.data = raw.copy()
    module.fit_upper_clothing([obj], rig, [{**arm, 'arm_surface_fit': {**settings, 'strength': 1}}, base], hand_surface={'arm_surface': surface})
    assert default == ([tuple(vertex.co) for vertex in obj.data.vertices], [tuple(normal.vector) for normal in obj.data.corner_normals],
                       [[(group.group, group.weight) for group in vertex.groups] for vertex in obj.data.vertices]), '显式strength=1不再与旧默认逐值一致'
    obj.data = raw.copy()
    settings = {**settings, 'strength': .98}
    arm = {**arm, 'arm_surface_fit': settings}
    report = module.fit_upper_clothing([obj], rig, [arm, base], hand_surface={'arm_surface': surface})
    assert min(areas()) > 1e-12, 'strength=.98仍将正源域子面投影塌缩'
    assert len(obj.data.polygons) == source_faces + 126, '肩帽没有按42原面只细分一次'
    evidence = report['arm_surface_fit'][0]
    assert evidence['source_face_ids'] == parents and set(parents) == set(range(source_faces)), '肩帽细分遗失源三角覆盖'
    assert evidence['subdivided_source_faces'] == 42, '肩帽细分范围或执行顺序错误'
    assert [tuple(face.vertices) for face in obj.data.polygons] == [tuple(face.vertices) for face in reference.polygons], '细分改变了参考表面之外的连接'
    assert [face.material_index for face in obj.data.polygons] == [face.material_index for face in reference.polygons], '肩帽改变了源材质槽'
    assert all((left.uv - right.uv).length < .000001 for left, right in zip(obj.data.uv_layers.active.data, reference.uv_layers.active.data)), '肩帽UV不符合源面插值'
    selected_faces = {index for component in components for index in component['faces']}
    active = {index for face in reference.polygons if parents[face.index] in selected_faces for index in face.vertices}
    target_points = [Vector(point) for point in surface['vertices']]
    trees = {sign: (triangles := [triangle for triangle in surface['triangles'] if all(target_points[index].x * sign > 0 for index in triangle)],
                    BVHTree.FromPolygons(target_points, triangles, all_triangles=True)) for sign in [1, -1]}
    moved, protected, shoulder_blends = 0, 0, 0
    for index, (point, old) in enumerate(zip(original_points, old_weights)):
        amount = .98 * max(0, min(1, (.42 - abs(point.x)) / .12)) * max(0, min(1, (point.z - 1.14) / .06)) if index in active and abs(point.x) > .12 else 0
        expected, binding = point, old
        if amount:
            triangles, tree = trees[1 if point.x >= 0 else -1]
            near, normal, face, _ = tree.find_nearest(point)
            expected = point + (near + normal * .003 - point) * amount
            binding = {name: value * (1 - amount) for name, value in old.items()}
            for target, weight in zip(triangles[face], poly_3d_calc([target_points[index] for index in triangles[face]], near)):
                for name, value in surface['weights'][target].items():
                    binding[name] = binding.get(name, 0) + value * weight * amount
            moved += 1
            shoulder_blends += binding.get('chest', 0) > 0
        else:
            protected += 1
        actual = obj.matrix_world @ obj.data.vertices[index].co
        assert (actual - expected).length < .000001, '肩帽没有贴合同侧真实肩臂或移动了范围外'
        weights = {obj.vertex_groups[group.group].name: group.weight for group in obj.data.vertices[index].groups if group.weight > 1e-7}
        assert max(abs(weights.get(name, 0) - binding.get(name, 0)) for name in set(weights) | set(binding)) < .000002, '肩帽没有按相同局部权重继承真实肩部蒙皮'
        if not amount:
            assert actual == point and weights == {name: value for name, value in old.items() if value > 1e-7}, '远端或未选衣片不再逐值保持'
    assert moved and protected and shoulder_blends, '没有实际覆盖肩部混合绑定与范围外对照'
    protected_normals = 0
    for face in obj.data.polygons:
        for loop in face.loop_indices:
            vertex = obj.data.vertices[obj.data.loops[loop].vertex_index]
            key = (parents[face.index], tuple(round(value, 7) for value in vertex.co),
                   tuple(round(value, 7) for value in obj.data.uv_layers.active.data[loop].uv))
            if key in source_normals:
                assert (obj.data.corner_normals[loop].vector - source_normals[key]).length < .0015, '未变原表面的自定义法线被重算'
                protected_normals += 1
    assert protected_normals > 100, '缺少范围外原法线对照'
    final = [vertex.co.copy() for vertex in obj.data.vertices]
    for override in [{'refine_abs_x': [.45, .12]}, {'fit_abs_x': [.42, .42]}, {'fit_z': [1.2, 1.14]}, {'subdivisions': -1}, {'subdivisions': 1.5},
                     {'fit_z': [1.14, float('nan')]}, {'offset': -.003}, {'refine_min_z': float('inf')},
                     {'strength': 0}, {'strength': -.01}, {'strength': 1.01}, {'strength': float('nan')}, {'strength': float('inf')}]:
        try:
            module.fit_upper_clothing([obj], rig, [base, {**arm, 'arm_surface_fit': {**settings, **override}}], hand_surface={'arm_surface': surface})
        except ValueError:
            pass
        else:
            raise AssertionError('非法肩帽范围没有在写入前拒绝')
        assert all(vertex.co == point for vertex, point in zip(obj.data.vertices, final)), '非法肩帽参数被发现前已执行前置矩阵'
    try:
        module.fit_upper_clothing([obj], rig, [base, arm])
    except ValueError:
        pass
    else:
        raise AssertionError('缺少本轮真实肩臂仍允许适配')
    assert all(vertex.co == point for vertex, point in zip(obj.data.vertices, final)), '缺少肩臂参考被发现前已写入'
    print('真实法师42源帽面细分、同侧肩臂与蒙皮插值、原UV及范围外保持通过', moved, protected, shoulder_blends,
          '默认塌缩', collapsed_before, 'strength=.98塌缩0，最小实际子面', min(areas()), flush=True)


# 真实布尔操作必须在所有来源面选择完成后执行，防止第一侧开孔使另一侧索引失效。
def verify_opening_hook():
    import bpy

    # 骨架和网格样件由真实Blender专项提供，不复制一个简化替身。
    def load(name, filename):
        specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    fixtures = load('cuff_hook_fixture', 'modular-character-cuff-opening-blender-test.py')
    module = load('cuff_hook_fit', 'modular-character-clothing-fit.py')
    obj, rig, _, _ = fixtures.sample_cuff(bpy)
    before = surface_properties(obj)
    adjustment = {'selector': {'nodes': [obj.name]}, 'cuff_opening': {'bone': 'lowerarm', 'radii': [.08, .079]}}
    try:
        module.fit_upper_clothing([obj], rig, [adjustment], hand_objects=[obj])
    except ValueError as error:
        assert '手套' in str(error), '手套开孔没有给出明确错误'
    else:
        raise AssertionError('独立拳套进入了开孔制作')
    assert surface_properties(obj) == before, '拒绝手套开孔时修改了原网格'
    report = module.fit_upper_clothing([obj], rig, [adjustment, adjustment])
    assert len(report['cuff_opening']) == 1, '重复配方对同一源组件重复开孔'
    assert report['cuff_opening'][0]['status'] == 'opened', '主制作钩子没有实际开孔'
    assert report['cuff_opening'][0]['lost_external_samples'] == 0, '开孔丢失了源外壁'
    assert fixtures.load('hook_opening_topology', 'modular-character-cuff-opening.py').topology(obj)['euler'] == 0, '制作钩子没有产生真实通孔'
    from mathutils import Matrix, Vector
    import math

    obj, rig, _, _ = fixtures.sample_cuff(bpy)
    rotation = Matrix.Rotation(math.radians(53), 3, 'Y')
    for vertex in obj.data.vertices:
        vertex.co = rotation @ vertex.co
    source_axis = obj.matrix_world.to_3x3() @ rotation @ Vector((1, 0, 0))
    report = module.fit_upper_clothing([obj], rig, [{'selector': {'nodes': [obj.name]}, 'align_on_axis': 'smallest', 'center_on_axis': True}])
    matrix = Matrix(report['operations'][0]['matrix'])
    target_axis = rig.matrix_world.to_3x3() @ (rig.data.bones['lowerarm.l'].tail_local - rig.data.bones['lowerarm.l'].head_local)
    assert abs((matrix.to_3x3() @ source_axis).normalized().dot(target_axis.normalized())) > .9999, '短筒取了长径而不是来源轴'
    print('主制作真实开孔与拳套保护检查通过', flush=True)


# 法师真实灰袖口入口跟随主袖矩阵，出口保持原来的拳掌位置及原面属性。
def verify_transform_weight(catalog_path, assets):
    import bpy
    from mathutils import Matrix

    specification = importlib.util.spec_from_file_location('weighted_clothing_fit', ROOT / 'scripts/modular-character-clothing-fit.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    catalog = json.loads(catalog_path.read_text())
    item = next(item for item in catalog['wearables'] if item['wearable_key'] == 'kaykit-adventurers-mage-upper')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(assets / (item['model_asset_key'] + '.glb')))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    trim = next(bpy.data.objects[name] for name in item['nodes'] if name.startswith('upper_hands'))
    original = [trim.matrix_world @ vertex.co for vertex in trim.data.vertices]
    normals = [normal.vector.copy() for normal in trim.data.corner_normals]
    properties = surface_properties(trim)
    start = .76
    report = module.fit_upper_clothing([trim], rig, [{'selector': {'nodes': [trim.name]}, 'scale': [1, 1.3, 1.3],
        'translation': [0, -.025, 0], 'transform_weight': {'from_abs_x': start, 'to_abs_x': 'component_end', 'values': [1, 0]}}])
    assert surface_properties(trim) == properties, '渐变矩阵改变了原袖口面或UV'
    for operation in report['operations']:
        matrix = Matrix(operation['matrix'])
        points = [point for point in original if (point.x >= 0) == (operation['side'] == '.l')]
        end = max(abs(point.x) for point in points)
        for vertex, point in zip(trim.data.vertices, original):
            if (point.x >= 0) != (operation['side'] == '.l'):
                continue
            weight = 1 - max(0, min(1, (abs(point.x) - start) / (end - start)))
            expected = point + (matrix @ point - point) * weight
            assert ((trim.matrix_world @ vertex.co) - expected).length < .000001, '袖口没有沿实际宽度渐变到原出口'
        for loop in trim.data.loops:
            point = original[loop.vertex_index]
            if (point.x >= 0) != (operation['side'] == '.l'):
                continue
            weight = 1 - max(0, min(1, (abs(point.x) - start) / (end - start)))
            jacobian = Matrix.Identity(3) + (matrix.to_3x3() - Matrix.Identity(3)) * weight
            if start <= abs(point.x) <= end:
                delta = matrix @ point - point
                derivative = -(1 if point.x > 0 else -1) / (end - start)
                for row in range(3):
                    jacobian[row][0] += delta[row] * derivative
            expected = (jacobian.inverted().transposed() @ normals[loop.index]).normalized()
            assert trim.data.corner_normals[loop.index].vector.dot(expected) > .9999, '袖口法线没有按真实渐变矩阵修正'
    print('真实袖口入口适配与出口保留检查通过', flush=True)


# 真实闭拳细分后仍使用原186面组件选择；身体数据经过场景重置仍能作为裸手参照。
def verify_palm_prepass(catalog_path, assets):
    import bpy
    from collections import Counter

    specification = importlib.util.spec_from_file_location('palm_prepass_fit', ROOT / 'scripts/modular-character-clothing-fit.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(source for source in recipe['sources'] if source['spec'].get('rigid_hand_clothing'))
    catalog = json.loads(catalog_path.read_text())
    body = next(body for body in catalog['characters'] if body['character_key'] == 'kaykit-medium-v1')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(assets / (body['model_asset_key'] + '.glb')))
    hand_surface = module.capture_hand_surface(bpy.data.objects['body_hands'])
    hand_surface['arm_surface'] = module.capture_hand_surface(bpy.data.objects['body_arms'])
    skeleton = next(body for body in catalog['characters'] if body['character_key'] == 'kaykit-skeleton-v1')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(assets / (skeleton['model_asset_key'] + '.glb')))
    hand_surface['skeleton_hand_surface'] = module.capture_hand_surface(bpy.data.objects['body_hands'])
    hand_surface['skeleton_arm_surface'] = module.capture_hand_surface(bpy.data.objects['body_arms'])
    hand_surface = json.loads(json.dumps(hand_surface))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    obj = bpy.data.objects['upper_native']
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    selector = {'materials': ['BrownDark'], 'bone_region': ['wrist', 'hand'], 'face_count': 186}
    component = module.select_components(module.mesh_components(obj), selector, rig)[0]
    source_faces = set(component['faces'])
    # 用实际角点位置和UV验证本次掌区之外的全部源面。
    def outside_signature():
        uv = obj.data.uv_layers.active
        return Counter((obj.data.materials[face.material_index].name,
                        tuple(sorted((tuple(round(value, 6) for value in obj.data.vertices[index].co),
                                      tuple(round(value, 6) for value in uv.data[loop].uv))
                                     for index, loop in zip(face.vertices, face.loop_indices))))
                       for face in obj.data.polygons
                       if not (obj.data.materials[face.material_index].name.split('.')[0] == 'BrownDark'
                               and all(obj.data.vertices[index].co.x > .5 for index in face.vertices)))
    before = outside_signature()
    report = module.fit_upper_clothing([obj], rig, [
        {'selector': selector, 'palm_surface_fit': {'offset': .008, 'cuff_x_scale': .4, 'max_edge_length': .025, 'subdivision_passes': 2, 'split_cuff': True}},
        {'selector': selector, 'translation': [0, .001, 0], 'bind_bone': 'hand', 'bind_from_bone': 'hand'}], hand_surface=hand_surface)
    assert len(report['operations']) == 1 and report['operations'][0]['rebound_vertices'] > 145, '掌区细分后丢失原组件选择语义'
    evidence = report['palm_surface_fit'][0]
    assert evidence['source_faces'] == 186 and set(evidence['source_face_ids_retained']) == source_faces, '局部细分丢失原拳套外面'
    assert evidence['result_faces'] > 186 and evidence['maximum_palm_displacement'] < .06, f'掌区没有有界地沿真实裸手适配：{evidence}'
    assert outside_signature() == before, '掌区制作改变了其他衣物表面或UV'
    seam = {}
    head = evidence['split_cuff']['plane_abs_x']
    for vertex in obj.data.vertices:
        if abs(vertex.co.x - head) < .000001:
            key = tuple(round(value, 5) for value in vertex.co)
            seam.setdefault(key, set()).update(obj.vertex_groups[group.group].name for group in vertex.groups if group.weight > .99)
    assert sum({'hand.l', 'lowerarm.l'} <= weights for weights in seam.values()) >= 8, '分区没有保留同位置但独立蒙皮的原边环'
    assert evidence['split_cuff']['seam_edges'] and evidence['split_cuff']['cuff_vertices'], '腕口没有按真实接合位置分区'
    assert evidence['maximum_uv_interpolation_error'] < .000001, '新掌面或接缝边环没有按原三角面插值UV'
    assert not any(attribute.name.startswith('_clothing_') or attribute.name.startswith('_palm_') for attribute in obj.data.attributes), '制作标记泄露到正式网格'
    # 内衬添加前后的整个拳套外面、UV、平滑标记和每个原顶点权重都必须相同。
    def shell_signature():
        uv = obj.data.uv_layers.active
        return Counter((obj.data.materials[face.material_index].name, face.use_smooth,
                        tuple(sorted((tuple(round(value, 6) for value in obj.data.vertices[index].co),
                                      tuple(round(value, 6) for value in uv.data[loop].uv),
                                      tuple(sorted((obj.vertex_groups[group.group].name, round(group.weight, 6)) for group in obj.data.vertices[index].groups)))
                                     for index, loop in zip(face.vertices, face.loop_indices)))) for face in obj.data.polygons)
    before_lining = shell_signature()
    face = next(face for face in obj.data.polygons if obj.data.materials[face.material_index].name.split('.')[0] == 'BrownDark')
    uv_layer = obj.data.uv_layers.active
    lining = module.add_wrist_lining({'object': obj, 'side': '.l', 'settings': {'offset': .004, 'bounds': [.695, .845]},
        'material': obj.data.materials[face.material_index], 'uv_layer': uv_layer.name,
        'uv': uv_layer.data[face.loop_indices[0]].uv.copy()}, rig, hand_surface)
    after_lining = shell_signature()
    assert not before_lining - after_lining, '腕内衬改变了原外壳的表面、UV或蒙皮'
    assert sum((after_lining - before_lining).values()) == sum(part['faces'] for part in lining['parts']), '腕内衬混入了额外的面'
    for part in lining['parts']:
        # 新切点的原坐标层是float32；狭长源三角的独立重心反算允许0.02%误差，原点权重严格不变。
        assert part['maximum_source_weight_error'] < .0002 and part['maximum_original_weight_error'] < .000001 and part['maximum_weight_sum_error'] < .00001, f'内衬没有保留真实来源蒙皮：{part}'
    for _, _, corners in after_lining - before_lining:
        xs = [abs(point[0]) for point, _, _ in corners]
        assert min(xs) >= .695 - .00001 and max(xs) <= .845 + .00001, '内衬超出腕段变成大块拳掌壳'
        assert not any(all(abs(x - bound) < .000001 for x in xs) for bound in [.695, .845]), '内衬新增了横截面封盖'
    assert not any(attribute.name.startswith('_lining_') for attribute in obj.data.attributes), '内衬来源标记泄露到正式网格'
    print('真实腕内衬源蒙皮、原外壳保持与无端盖检查通过', flush=True)
    print('真实闭拳预处理、场景重置与来源选择保持检查通过', flush=True)


# 记录真实UV、材质槽和连接关系，适配不能把原开口补平或丢掉内壁。
def surface_properties(obj):
    uv = obj.data.uv_layers.active
    return {'faces': [tuple(face.vertices) for face in obj.data.polygons],
            'materials': [face.material_index for face in obj.data.polygons],
            'uv': [tuple(loop.uv) for loop in uv.data] if uv else [],
            'smooth': [face.use_smooth for face in obj.data.polygons]}


# 每个源顶点都遵守同一可逆矩阵，证明没有逐点径向扩张和厚度塌陷。
def verify(catalog_path):
    import bpy
    from mathutils import Matrix

    specification = importlib.util.spec_from_file_location('real_clothing_fit', ROOT / 'scripts/modular-character-clothing-fit.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    catalog = json.loads(catalog_path.read_text())
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    cases = {
        'kaykit-legacy-skeleton-mage-upper': [{'selector': {'materials': ['PurpleDark', 'WoodDark'], 'bone_region': 'upperarm'}, 'scale': [1, 1.35, 1], 'translation': [0, 0, -.035]}],
        'kaykit-legacy-skeleton-archer-upper': [{'selector': {'materials': ['Stone'], 'bone_region': 'forearm'}, 'scale': [1, 1, 1.45]}],
    }
    for key, adjustments in cases.items():
        assert any(item['wearable_key'] == key for item in catalog['wearables']), '目录缺少需要验收的旧版上装'
        source = next(source for source in recipe['sources'] if source['key'] + '-upper' == key)
        path = ROOT / source['normalized_model']
        bpy.ops.wm.read_factory_settings(use_empty=True)
        # 原组件分区/面数是归一化原件的契约；最终GLB已移动腕筒并开孔，不能再次当原件使用。
        bpy.ops.import_scene.gltf(filepath=str(path))
        objects = [bpy.data.objects['upper_native']]
        print('原组件回归输入', key, str(path), flush=True)
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        original = {obj: [obj.matrix_world @ vertex.co for vertex in obj.data.vertices] for obj in objects}
        properties = {obj: surface_properties(obj) for obj in objects}
        weights = {obj: [[(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups] for vertex in obj.data.vertices] for obj in objects}
        components = [(component, module.component_region(component['center'], rig)) for obj in objects for component in module.mesh_components(obj)]
        report = module.fit_upper_clothing(objects, rig, adjustments)
        assert len(report['operations']) == 2, key + ': 左右部件没有一起完成'
        assert report['faces_before'] == report['faces_after'], key + ': 衣物开口或壁面被改变'
        moved = 0
        for operation in report['operations']:
            matrix = Matrix(operation['matrix'])
            assert matrix.determinant() > 0, key + ': 部件被翻转或压扁'
            assert operation['maximum_displacement'] < .10, key + ': 局部调整产生了过大变形'
            for component, region in components:
                if region != operation['selector']['bone_region'] or not set(component['materials']) <= set(operation['selector']['materials']):
                    continue
                if (component['center'].x >= 0) != (operation['side'] == '.l'):
                    continue
                obj = component['object']
                for index in component['vertices']:
                    expected = matrix @ original[obj][index]
                    actual = obj.matrix_world @ obj.data.vertices[index].co
                    assert (actual - expected).length < .000001, key + ': 同一衣片没有使用共同矩阵'
                    moved += (actual - original[obj][index]).length > .000001
        assert moved, key + ': 实际部件没有适配'
        for obj in objects:
            assert surface_properties(obj) == properties[obj], key + ': 源UV、材质或开口改变'
            assert [[(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups] for vertex in obj.data.vertices] == weights[obj], key + ': 未声明的蒙皮发生改变'
        if key.endswith('archer-upper'):
            before_badge = {obj: [vertex.co.copy() for vertex in obj.data.vertices] for obj in objects}
            badge_report = module.fit_upper_clothing(objects, rig, [{'selector': {'materials': ['Stone'], 'bone_region': 'forearm', 'face_count': 16}, 'translation': [0, 0, .004]}])
            assert sum(operation['faces'] for operation in badge_report['operations']) == 32, '独立装饰件选择混入主袖管'
            module.fit_upper_clothing(objects, rig, [{'selector': {'materials': ['Stone'], 'bone_region': 'forearm', 'face_count': 16}, 'translation': [0, 0, -.004]}])
            assert all((vertex.co - before_badge[obj][vertex.index]).length < .000001 for obj in objects for vertex in obj.data.vertices), '独立装饰件矩阵不能还原'
            unchanged = {obj: [obj.matrix_world @ vertex.co for vertex in obj.data.vertices] for obj in objects}
            selector = {'materials': ['Stone'], 'bone_region': 'forearm'}
            crossing = module.fit_upper_clothing(objects, rig, [{'selector': selector, 'translation': [.30, 0, 0]}, {'selector': selector, 'translation': [-.30, 0, 0]}])
            assert len(crossing['operations']) == 4, '跨过关节后第二个调整丢失原部件'
            assert all(((obj.matrix_world @ vertex.co) - unchanged[obj][index]).length < .000001 for obj in objects for index, vertex in enumerate(obj.data.vertices)), '选择条件没有保持原始部件语义'
        if key.endswith('archer-upper'):
            node = objects[0]
            previous_name = node.name
            node.name = 'upper_source.001'
            exported_node = 'upper_source001'
            alias_report = module.fit_upper_clothing(objects, rig, [{'selector': {'nodes': [exported_node]}, 'translation': [0, .001, 0]}])
            assert alias_report['operations'], '正式导出节点名没有匹配原始Blender节点'
            module.fit_upper_clothing(objects, rig, [{'selector': {'nodes': [exported_node]}, 'translation': [0, -.001, 0]}])
            node.name = previous_name
            untouched = {obj: [obj.matrix_world @ vertex.co for vertex in obj.data.vertices] for obj in objects}
            sleeve_components = [component for obj in objects for component in module.mesh_components(obj) if set(component['materials']) <= {'Stone'} and module.component_region(component['center'], rig) == 'forearm']
            module.fit_upper_clothing(objects, rig, [{'selector': selector, 'translation': [0, .005, 0], 'transform_from_bone': 'wrist'}])
            local_moved = 0
            for component in sleeve_components:
                obj = component['object']
                side = '.l' if component['center'].x >= 0 else '.r'
                boundary = abs((rig.matrix_world @ rig.data.bones['wrist' + side].head_local).x)
                for index in component['vertices']:
                    difference = (obj.matrix_world @ obj.data.vertices[index].co) - untouched[obj][index]
                    if abs(untouched[obj][index].x) < boundary:
                        assert difference.length < .000001, '袖口局部矩阵移动了近端肩肘'
                    else:
                        assert abs(difference.y - .005) < .000001 and abs(difference.x) < .000001 and abs(difference.z) < .000001, '袖口局部位移超过声明矩阵'
                        local_moved += 1
            assert local_moved, '袖口局部矩阵没有改变真实远端表面'
            module.fit_upper_clothing(objects, rig, [{'selector': selector, 'translation': [0, -.005, 0], 'transform_from_bone': 'wrist'}])
            before_binding = {obj: [[(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups] for vertex in obj.data.vertices] for obj in objects}
            regions = [component for obj in objects for component in module.mesh_components(obj) if set(component['materials']) <= {'Stone'} and module.component_region(component['center'], rig) == 'forearm']
            limited = module.fit_upper_clothing(objects, rig, [{'selector': selector, 'bind_bone': 'lowerarm', 'bind_from_bone': 'wrist'}])
            assert sum(operation['rebound_vertices'] for operation in limited['operations']) > 0, '骨段范围重绑没有选中真实袖口'
            for component in regions:
                obj = component['object']
                side = '.l' if component['center'].x >= 0 else '.r'
                boundary = abs((rig.matrix_world @ rig.data.bones['wrist' + side].head_local).x)
                for index in component['vertices']:
                    vertex = obj.data.vertices[index]
                    actual = [(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups]
                    if abs((obj.matrix_world @ vertex.co).x) >= boundary:
                        assert actual == [('lowerarm' + side, 1.0)], '袖口没有绑定到声明骨段'
                    else:
                        assert actual == before_binding[obj][index], '局部重绑改变了范围外的上臂或肘'
            near_weights = {obj: [[(obj.vertex_groups[group.group].name, group.weight) for group in vertex.groups] for vertex in obj.data.vertices] for obj in objects}
            mixed = module.fit_upper_clothing(objects, rig, [{'selector': selector, 'bind_weights': {'chest': .15, 'upperarm': .85}, 'bind_from_bone': 'wrist'}])
            assert sum(operation['rebound_vertices'] for operation in mixed['operations']) > 0, '固定混合没有选中实际部件'
            for component in regions:
                obj = component['object']
                side = '.l' if component['center'].x >= 0 else '.r'
                boundary = abs((rig.matrix_world @ rig.data.bones['wrist' + side].head_local).x)
                for index in component['vertices']:
                    vertex = obj.data.vertices[index]
                    actual = {obj.vertex_groups[group.group].name: group.weight for group in vertex.groups}
                    if abs((obj.matrix_world @ vertex.co).x) >= boundary:
                        assert abs(actual['chest'] - .15) < .000001 and abs(actual['upperarm' + side] - .85) < .000001 and len(actual) == 2, '固定权重没有正确映射左右或归一化'
                    else:
                        assert list(actual.items()) == near_weights[obj][index], '固定混合修改了范围外近端'
            report = module.fit_upper_clothing(objects, rig, [{'selector': {'materials': ['BrownDark'], 'bone_region': ['wrist', 'hand']}, 'bind_bone': 'hand'}])
            assert report['operations'] and sum(operation['rebound_vertices'] for operation in report['operations']) > 0, '真实闭口拳套没有执行显式重绑'
            for obj in objects:
                assert surface_properties(obj) == properties[obj], '显式重绑改变了源拳套表面'
        print('真实部件矩阵检查通过', key, moved, flush=True)


# 原件边长的统一倍率证明拳套经过刚性旋转和等比缩放，没有被整臂方盒压扁。
def verify_hand_restoration(input_directory=None):
    import bpy
    from mathutils import Vector

    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    for source in recipe['sources']:
        declaration = source['spec'].get('rigid_hand_clothing')
        if not declaration:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / declaration['reference']['path']))
        reference_obj = bpy.data.objects[declaration['reference']['node']]
        layer = reference_obj.data.uv_layers.active
        reference_points = []
        for face in reference_obj.data.polygons:
            uv = sum((layer.data[index].uv for index in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
            if any(left <= uv.x < right and bottom <= uv.y < top for left, right, bottom, top in declaration['reference']['uv_regions']):
                reference_points.extend(reference_obj.matrix_world @ reference_obj.data.vertices[index].co for index in face.vertices)
        reference_centers = {sign: Vector(tuple((min(point[axis] for point in reference_points if point.x * sign > 0) + max(point[axis] for point in reference_points if point.x * sign > 0)) / 2 for axis in range(3))) for sign in [1, -1]}
        expected = {}
        for sign, role in [(1, 'left_arm_nodes'), (-1, 'right_arm_nodes')]:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=str(ROOT / source['source']))
            lengths, textures, faces, all_points = [], [], 0, []
            for name in source['spec'][role]:
                obj = bpy.data.objects[name]
                obj.data.calc_loop_triangles()
                uv = obj.data.uv_layers.active
                for triangle in obj.data.loop_triangles:
                    material = obj.data.materials[triangle.material_index].name.split('.')[0]
                    if material not in declaration['materials']:
                        continue
                    points = [obj.matrix_world @ obj.data.vertices[index].co for index in triangle.vertices]
                    all_points.extend(point.copy() for point in points)
                    lengths.extend((points[index] - points[(index + 1) % 3]).length for index in range(3))
                    if uv:
                        textures.append(tuple(sorted(tuple(round(value, 6) for value in uv.data[index].uv) for index in triangle.loops)))
                    faces += 1
            expected[sign] = (sorted(lengths), sorted(textures), faces, all_points)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        path = input_directory / (source['key'] + '.glb') if input_directory else ROOT / source['normalized_model']
        bpy.ops.import_scene.gltf(filepath=str(path))
        obj = bpy.data.objects['upper_native']
        obj.data.calc_loop_triangles()
        uv = obj.data.uv_layers.active
        for sign in [1, -1]:
            lengths, textures, faces, all_points = [], [], 0, []
            for triangle in obj.data.loop_triangles:
                material = obj.data.materials[triangle.material_index].name.split('.')[0]
                points = [obj.matrix_world @ obj.data.vertices[index].co for index in triangle.vertices]
                if material not in declaration['materials'] or not all(point.x * sign > .5 for point in points):
                    continue
                all_points.extend(point.copy() for point in points)
                lengths.extend((points[index] - points[(index + 1) % 3]).length for index in range(3))
                if uv:
                    textures.append(tuple(sorted(tuple(round(value, 6) for value in uv.data[index].uv) for index in triangle.loops)))
                for index in triangle.vertices:
                    groups = [(obj.vertex_groups[group.group].name, group.weight) for group in obj.data.vertices[index].groups if group.weight > .00001]
                    assert groups == [('hand.l' if sign > 0 else 'hand.r', 1.0)], '原闭口拳套没有按整件跟随手骨'
                faces += 1
            original_lengths, original_textures, original_faces, raw_points = expected[sign]
            assert faces == original_faces, '源闭口拳套丢面或混入其他部件'
            assert sorted(textures) == original_textures, '源闭口拳套UV发生改变'
            if not original_faces:
                continue
            ratios = [actual / original for actual, original in zip(sorted(lengths), original_lengths) if original > .00001]
            assert max(ratios) - min(ratios) < .001, '拳套仍被非等比归一化压扁'
            source_center = Vector(tuple((min(point[axis] for point in raw_points) + max(point[axis] for point in raw_points)) / 2 for axis in range(3)))
            palm = [point for point in raw_points if point.z <= declaration['palm_max_z']]
            palm_center = Vector(tuple((min(point[axis] for point in palm) + max(point[axis] for point in palm)) / 2 for axis in range(3)))
            actual_center = Vector(tuple((min(point[axis] for point in all_points) + max(point[axis] for point in all_points)) / 2 for axis in range(3)))
            delta = source_center - palm_center
            rotation_delta = Vector((-sign * delta.z, delta.y, sign * delta.x))
            restored_palm_center = actual_center - rotation_delta * (sum(ratios) / len(ratios))
            assert (restored_palm_center - reference_centers[sign]).length < .0001, '拳掌没有对齐真实裸拳中心，卷起腕口影响了定位'
            print('原闭拳等比恢复检查通过', source['key'], sign, faces, sum(ratios) / len(ratios), flush=True)


# 对照显式给定的旧输入，源拳套之外的身体、衣片、帽子和UV不能被定向修复改变。
def verify_unchanged_parts(baseline, normalized_directory=None):
    import bpy
    from collections import Counter

    specification = importlib.util.spec_from_file_location('unchanged_clothing_compare', ROOT / 'scripts/legacy-character-clothing-blender-test.py')
    comparison = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(comparison)
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(source for source in recipe['sources'] if source['spec'].get('rigid_hand_clothing'))
    materials = source['spec']['rigid_hand_clothing']['materials']
    snapshots = []
    target = normalized_directory / (source['key'] + '.glb') if normalized_directory else ROOT / source['normalized_model']
    for path in [baseline, target]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
        geometry, textures = {}, {}
        for obj in bpy.data.objects:
            if obj.type != 'MESH':
                continue
            obj.data.calc_loop_triangles()
            uv = obj.data.uv_layers.active
            triangles, coordinates = Counter(), Counter()
            for triangle in obj.data.loop_triangles:
                material = obj.data.materials[triangle.material_index].name.split('.')[0] if obj.data.materials else ''
                points = [obj.matrix_world @ obj.data.vertices[index].co for index in triangle.vertices]
                if material in materials and all(abs(point.x) > .5 for point in points):
                    continue
                triangles[(tuple(sorted(tuple(round(value, 6) for value in point) for point in points)), material)] += 1
                texture = tuple(sorted(tuple(round(value, 6) for value in uv.data[index].uv) for index in triangle.loops)) if uv else ()
                coordinates[(material, texture)] += 1
            geometry[obj.name], textures[obj.name] = triangles, coordinates
        snapshots.append((geometry, textures))
    old, old_uv = snapshots[0]
    new, new_uv = snapshots[1]
    assert old.keys() == new.keys(), '定向拳套修复改变了其他节点'
    for name in old:
        missing, added = comparison.unmatched_triangles(old[name], new[name])
        assert not missing and not added, name + ': 拳套之外的真实表面改变'
        assert old_uv[name] == new_uv[name], name + ': 拳套之外的UV改变'
    print('非拳套表面与UV保持检查通过', len(old), sum(sum(records.values()) for records in old.values()), flush=True)


if __name__ == '__main__':
    verify_directional_z_transition_plane()
    verify_opening_hook()
    verify_weight_remap()
    verify_transform_weight_z()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/character/character-catalog.json')
    parser.add_argument('--assets', type=Path, default=ROOT / 'internal/assets/builtin')
    parser.add_argument('--normalized-directory', type=Path)
    parser.add_argument('--baseline-normalized', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    verify_arm_surface_fit(args.catalog, args.assets)
    verify_palm_prepass(args.catalog, args.assets)
    verify_transform_weight(args.catalog, args.assets)
    verify(args.catalog)
    verify_hand_restoration(args.normalized_directory)
    if args.baseline_normalized:
        verify_unchanged_parts(args.baseline_normalized, args.normalized_directory)
