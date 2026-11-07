"""按真实连通件离线整理衣物，保留原来的开口、UV、材质及骨架。"""
import argparse
import importlib.util
import json
from math import isfinite
import re
from pathlib import Path
import sys
from typing import NotRequired, TypedDict

ROOT = Path(__file__).resolve().parents[1]


# 选择依据来自源网格和标准骨骼，不依赖面向用户的商品名称。
class ComponentSelector(TypedDict):
    materials: NotRequired[list[str]]  # 来源材质名，忽略Blender添加的数字后缀。
    bone_region: NotRequired[str | list[str]]  # torso、upperarm、forearm、wrist或hand。
    nodes: NotRequired[list[str]]  # 可明确选择独立手部衣物等来源节点。
    face_count: NotRequired[int]  # 冻结来源中已核对的完整组件面数，用于区分同材质的筒身和扣件。


# 袖口入口到出口只渐变同一个矩阵，出口可沿用当前手套的原尺寸。
class TransformWeight(TypedDict):
    from_abs_x: float  # 标准身体绑定姿势下的入口位置。
    to_abs_x: float | str  # 结束位置，component_end使用本侧选中部件实际末端。
    values: list[float]  # 两端矩阵权重，入口跟随且出口保持原样时为[1, 0]。
    z_bounds: NotRequired[list[float]]  # 可选世界高度区间，首端完整、末端归零，可递增或递减，与X权重相乘。


# 裸手来自本次身体制作结果；纯数值在场景重置之后仍然有效。
class HandSurface(TypedDict):
    vertices: list[list[float]]  # 绑定姿势的世界坐标。
    triangles: list[list[int]]  # 对应真实表面三角索引。
    weights: list[dict[str, float]]  # 来源顶点的真实骨骼权重，不保留Blender组对象。
    arm_surface: NotRequired['HandSurface']  # 本轮真实人形前臂端。
    skeleton_hand_surface: NotRequired['HandSurface']  # 本轮固定骨架的掌腕表面。
    skeleton_arm_surface: NotRequired['HandSurface']  # 本轮固定骨架的前臂端。


# 内衬只覆盖明确的腕区，沿用来源棕材质和真实身体权重。
class WristLiningSettings(TypedDict):
    offset: float  # 相对真实皮肤的小间隙，单位米。
    bounds: list[float]  # 标准身体上腕段的absX范围，重叠边藏在原壳内。


# 闭掌外推和腕口分区均为来源配方中的明确制作选择。
class PalmSurfaceSettings(TypedDict):
    offset: float  # 实际裸拳凸包外侧的小间隙，单位米。
    cuff_x_scale: float  # 卷边沿手骨起点缩短，保留原掌和卷边截面。
    max_edge_length: float  # 原掌局部细分的边长阈值。
    subdivision_passes: int  # 有界细分次数，不改变其他衣物。
    split_cuff: NotRequired[bool]  # 遮蔽接缝下的原表面分区，腕口随前臂而掌壳随手。
    wrist_lining: NotRequired[WristLiningSettings]  # 分区缝内的薄棕内衬，不放大原闭拳外壳。


# 肩帽只在声明范围内细分，再局部贴合本轮真实肩臂，不改变其他衣片。
class ArmSurfaceSettings(TypedDict):
    refine_abs_x: list[float]  # 允许细分的世界absX开区间。
    refine_min_z: float  # 原面至少有一个角点超过此世界高度才细分。
    subdivisions: int  # 局部细分次数，每轮各边增加一个点。
    fit_abs_x: list[float]  # 位置和蒙皮混合的X区间，低端1、高端0。
    fit_z: list[float]  # 位置和蒙皮混合的高度区间，低端0、高端1。
    offset: float  # 真实肩臂外壁沿面法线的间隙，单位米。
    strength: NotRequired[float]  # 位置与蒙皮共用的混合强度，默认1；略小于1时保留原曲面差异。


# 每组左右部件各自使用一个小矩阵，禁止逐顶点除以半径造成长刺。
class ComponentAdjustment(TypedDict):
    selector: ComponentSelector  # 已审核的部件选择条件。
    scale: NotRequired[list[float]]  # 单组部件的XYZ比例，默认不缩放。
    translation: NotRequired[list[float]]  # 平移量；X按左右侧镜像。
    center_on_axis: NotRequired[bool]  # 闭合袖管的截面中心对齐真实骨轴。
    align_on_axis: NotRequired[bool | str]  # True取最接近骨轴的主轴；smallest明确取短筒最小方差轴。
    bind_bone: NotRequired[str]  # 明确需要刚性跟随的hand、wrist或lowerarm。
    bind_weights: NotRequired[dict[str, float]]  # 少量已核实的固定混合；成对骨自动补左右后缀。
    weight_remap: NotRequired[dict[str, str]]  # 精确源骨名→目标骨名；等量累加，保留所有其他权重。
    bind_from_bone: NotRequired[str]  # 仅重绑原位置在该骨头起点及远端的顶点。
    transform_from_bone: NotRequired[str]  # 仅变换源位置在该骨头起点及远端的袖口。
    palm_surface_fit: NotRequired[PalmSurfaceSettings]  # 原闭拳的局部细分、裸拳外侧间隙和腕口轴向比例。
    arm_surface_fit: NotRequired[ArmSurfaceSettings]  # 旧矩阵完成后局部贴合本轮真实肩臂，保留源面及UV。
    cuff_opening: NotRequired[dict]  # 明确审核的实心臂筒，以真实骨轴开孔；完整拳套禁止选择。
    transform_weight: NotRequired[TransformWeight]  # 有界轴向渐变，保留原来的入口与出口拓扑。


# glTF为UV和材质复制过顶点；同一位置的面仍属于同一真实部件。
def mesh_components(obj):
    from mathutils import Vector

    face_points, position_faces = {}, {}
    for face in obj.data.polygons:
        points = {tuple(round(value, 5) for value in obj.data.vertices[index].co) for index in face.vertices}
        face_points[face.index] = points
        for point in points:
            position_faces.setdefault(point, set()).add(face.index)
    remaining = set(face_points)
    components = []
    while remaining:
        pending, faces = [min(remaining)], set()
        while pending:
            index = pending.pop()
            if index not in remaining:
                continue
            remaining.remove(index)
            faces.add(index)
            pending.extend(neighbor for point in face_points[index] for neighbor in position_faces[point] if neighbor in remaining)
        vertices = sorted({index for face in faces for index in obj.data.polygons[face].vertices})
        points = [obj.matrix_world @ obj.data.vertices[index].co for index in vertices]
        bounds = [(min(point[axis] for point in points), max(point[axis] for point in points)) for axis in range(3)]
        components.append({'object': obj, 'faces': sorted(faces), 'vertices': vertices,
                           'materials': sorted({obj.data.materials[obj.data.polygons[index].material_index].name.split('.')[0] for index in faces}),
                           'center': Vector(tuple((low + high) / 2 for low, high in bounds)), 'bounds': bounds})
    return components


# 以实际骨头关节分区，左右镜像部件遵循同一来源标注。
def component_region(center, rig):
    side = '.l' if center.x >= 0 else '.r'
    distance = abs(center.x)
    if distance < abs((rig.matrix_world @ rig.data.bones['upperarm' + side].head_local).x):
        return 'torso'
    for bone, region in [('lowerarm', 'upperarm'), ('wrist', 'forearm'), ('hand', 'wrist')]:
        if distance < abs((rig.matrix_world @ rig.data.bones[bone + side].head_local).x):
            return region
    return 'hand'


# 截面中心沿真实骨轴定位；不会把整个上装缩放到身体方盒。
def arm_axis_at_x(rig, side, x):
    names = ['upperarm', 'lowerarm', 'wrist', 'hand']
    bones = [rig.matrix_world @ rig.data.bones[name + side].head_local for name in names]
    bones.append(rig.matrix_world @ rig.data.bones['hand' + side].tail_local)
    for start, end in zip(bones, bones[1:]):
        if min(start.x, end.x) <= x <= max(start.x, end.x):
            return start.lerp(end, (x - start.x) / (end.x - start.x))
    return min(bones, key=lambda point: abs(point.x - x)).copy()


# 来源管件可能仍沿原垂臂倾斜；用成熟主轴分解选最接近骨轴的方向，不逐点弯曲。
def component_axis_rotation(group, rig, side, center, choice=True):
    import numpy as np
    from mathutils import Vector

    primary = max(group, key=lambda component: len(component['faces']))
    obj = primary['object']
    points = sorted({tuple(obj.matrix_world @ obj.data.vertices[index].co) for index in primary['vertices']})
    array = np.asarray(points, dtype=float)
    centered = array - array.mean(axis=0)
    _, axes = np.linalg.eigh(centered.T @ centered)
    target = (arm_axis_at_x(rig, side, center.x + .001 * (1 if side == '.l' else -1)) - arm_axis_at_x(rig, side, center.x - .001 * (1 if side == '.l' else -1))).normalized()
    candidates = [Vector(tuple(axes[:, index])) for index in range(3)]
    source = candidates[0] if choice == 'smallest' else max(candidates, key=lambda axis: abs(axis.dot(target)))
    if source.dot(target) < 0:
        source = -source
    return source.rotation_difference(target).to_matrix().to_4x4()


# 跨Blender场景只传数值，目标始终来自本轮已经完成制作的真实裸手。
def capture_hand_surface(obj) -> HandSurface:
    obj.data.calc_loop_triangles()
    return {'vertices': [list(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices],
            'triangles': [list(triangle.vertices) for triangle in obj.data.loop_triangles],
            'weights': [{obj.vertex_groups[group.group].name: group.weight for group in vertex.groups if group.weight > .000001}
                        for vertex in obj.data.vertices]}


# 每个来源对象批量细分两侧肩帽，随后只采样本轮同侧真实肩臂，保留其余原面。
def fit_arm_surface(components, settings: ArmSurfaceSettings, surface: HandSurface):
    import bmesh
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.interpolate import poly_3d_calc

    targets = [Vector(point) for point in surface['vertices']]
    trees = {}
    for sign in [1, -1]:
        triangles = [triangle for triangle in surface['triangles'] if all(targets[index].x * sign > 0 for index in triangle)]
        trees[sign] = (triangles, BVHTree.FromPolygons(targets, triangles, all_triangles=True))
    reports = []
    for obj in dict.fromkeys(component['object'] for component in components):
        selected = {index for component in components if component['object'] == obj for index in component['faces']}
        uv = obj.data.uv_layers.active
        original = {face.index: {(tuple(round(value, 7) for value in obj.data.vertices[obj.data.loops[loop].vertex_index].co),
                                 tuple(round(value, 7) for value in uv.data[loop].uv)): obj.data.corner_normals[loop].vector.copy()
                                for loop in face.loop_indices} for face in obj.data.polygons}
        initial_faces = len(obj.data.polygons)
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        mesh.faces.ensure_lookup_table()
        mesh.edges.ensure_lookup_table()
        parent = mesh.faces.layers.int.new('_arm_surface_parent')
        for face in mesh.faces:
            face[parent] = face.index
        refined = set()
        for _ in range(settings['subdivisions']):
            chosen = [face for face in mesh.faces if face[parent] in selected
                      and all(settings['refine_abs_x'][0] < abs((obj.matrix_world @ vertex.co).x) < settings['refine_abs_x'][1] for vertex in face.verts)
                      and max((obj.matrix_world @ vertex.co).z for vertex in face.verts) > settings['refine_min_z']]
            refined.update(face[parent] for face in chosen)
            edges = sorted({edge for face in chosen for edge in face.edges}, key=lambda edge: edge.index)
            if edges:
                bmesh.ops.subdivide_edges(mesh, edges=edges, cuts=1, use_grid_fill=True)
            mesh.edges.index_update()
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        parents = [value.value for value in obj.data.attributes['_arm_surface_parent'].data]
        active = {index for face in obj.data.polygons if parents[face.index] in selected for index in face.vertices}
        inverse = obj.matrix_world.inverted()
        moved = 0
        for index in sorted(active):
            vertex = obj.data.vertices[index]
            point = obj.matrix_world @ vertex.co
            if abs(point.x) <= settings['refine_abs_x'][0]:
                continue
            low, high = settings['fit_abs_x']
            x_weight = max(0, min(1, (high - abs(point.x)) / (high - low)))
            low, high = settings['fit_z']
            amount = x_weight * max(0, min(1, (point.z - low) / (high - low))) * settings.get('strength', 1)
            if not amount:
                continue
            triangles, tree = trees[1 if point.x >= 0 else -1]
            near, normal, triangle, _ = tree.find_nearest(point)
            vertex.co = inverse @ (point + (near + normal * settings['offset'] - point) * amount)
            # 新点已有BMesh插值的原权重，按同一amount与目标真实肩权重混合。
            binding = {obj.vertex_groups[group.group].name: group.weight * (1 - amount) for group in vertex.groups}
            barycentric = poly_3d_calc([targets[index] for index in triangles[triangle]], near)
            for target, weight in zip(triangles[triangle], barycentric):
                for name, value in surface['weights'][target].items():
                    binding[name] = binding.get(name, 0) + value * weight * amount
            for group in obj.vertex_groups:
                group.remove([index])
            for name, value in binding.items():
                if value > 1e-7:
                    group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                    group.add([index], value, 'REPLACE')
            moved += 1
        obj.data.update()
        uv = obj.data.uv_layers.active
        normals = []
        for face in obj.data.polygons:
            for loop in face.loop_indices:
                vertex = obj.data.vertices[obj.data.loops[loop].vertex_index]
                key = (tuple(round(value, 7) for value in vertex.co), tuple(round(value, 7) for value in uv.data[loop].uv))
                normals.append(original[parents[face.index]].get(key, vertex.normal.copy()))
        obj.data.normals_split_custom_set(normals)
        obj.data.attributes.remove(obj.data.attributes['_arm_surface_parent'])
        reports.append({'object': obj.name, 'settings': settings, 'source_faces': initial_faces,
                        'result_faces': len(obj.data.polygons), 'source_face_ids': parents,
                        'subdivided_source_faces': len(refined), 'moved_vertices': moved,
                        'weight_method': 'original-and-same-side-arm-triangle-barycentric-blend'})
    return reports


# 原掌只向实际裸手凸包外推；腕口缩短和局部细分均为明确的离线制作参数。
def fit_palm_surface(component, rig, settings: PalmSurfaceSettings, hand_surface: HandSurface):
    import bpy
    import bmesh
    from mathutils import Vector

    obj = component['object']
    source_positions = obj.data.attributes['_clothing_source_position']
    uv_layer = obj.data.uv_layers.active
    source_uv = {index: [(source_positions.data[vertex].vector.copy(), uv_layer.data[loop].uv.copy())
                         for vertex, loop in zip(obj.data.polygons[index].vertices, obj.data.polygons[index].loop_indices)]
                 for index in component['faces']} if uv_layer else {}
    side = '.l' if component['center'].x >= 0 else '.r'
    sign = 1 if side == '.l' else -1
    head = abs((rig.matrix_world @ rig.data.bones['hand' + side].head_local).x)
    inverse = obj.matrix_world.inverted()
    selected = set(component['vertices'])
    for index in selected:
        point = obj.matrix_world @ obj.data.vertices[index].co
        if abs(point.x) < head:
            point.x = sign * (head + (abs(point.x) - head) * settings['cuff_x_scale'])
            obj.data.vertices[index].co = inverse @ point
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.verts.ensure_lookup_table()
    mesh.faces.ensure_lookup_table()
    source_layer = mesh.faces.layers.int.new('_palm_source_surface')
    for face in mesh.faces:
        face[source_layer] = face.index + 1 if face.index in component['faces'] else 0
    bmesh.ops.remove_doubles(mesh, verts=[mesh.verts[index] for index in selected], dist=.000001)
    for _ in range(settings['subdivision_passes']):
        edges = [edge for edge in mesh.edges
                 if any(face[source_layer] for face in edge.link_faces)
                 and all(abs((obj.matrix_world @ vertex.co).x) >= head - .005 for vertex in edge.verts)
                 and edge.calc_length() > settings['max_edge_length']]
        if not edges:
            break
        bmesh.ops.subdivide_edges(mesh, edges=edges, cuts=1, use_grid_fill=True)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(obj.data)
    mesh.free()
    hull = bmesh.new()
    for point in hand_surface['vertices']:
        if point[0] * sign > 0:
            hull.verts.new(Vector(point))
    bmesh.ops.convex_hull(hull, input=list(hull.verts))
    bmesh.ops.recalc_face_normals(hull, faces=list(hull.faces))
    data = bpy.data.meshes.new('真实裸拳凸包目标')
    hull.to_mesh(data)
    hull.free()
    target = bpy.data.objects.new('真实裸拳凸包目标', data)
    bpy.context.collection.objects.link(target)
    mask = obj.vertex_groups.new(name='_palm_surface_fit')
    source_attribute = obj.data.attributes['_palm_source_surface']
    palm_indices = {index for face in obj.data.polygons if source_attribute.data[face.index].value
                    for index in face.vertices if abs((obj.matrix_world @ obj.data.vertices[index].co).x) >= head}
    mask.add(sorted(palm_indices), 1, 'REPLACE')
    before = [vertex.co.copy() for vertex in obj.data.vertices]
    modifier = obj.modifiers.new('闭拳实际表面外侧间隙', 'SHRINKWRAP')
    modifier.target = target
    modifier.wrap_method = 'NEAREST_SURFACEPOINT'
    modifier.wrap_mode = 'OUTSIDE'
    modifier.offset = settings['offset']
    modifier.vertex_group = mask.name
    mask_name, modifier_name = mask.name, modifier.name
    try:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        while obj.modifiers.find(modifier_name) > 0:
            bpy.ops.object.modifier_move_up(modifier=modifier_name)
        bpy.ops.object.modifier_apply(modifier=modifier_name)
    finally:
        remaining = obj.modifiers.get(modifier_name)
        if remaining is not None:
            obj.modifiers.remove(remaining)
        obj.vertex_groups.remove(obj.vertex_groups[mask_name])
        bpy.data.objects.remove(target, do_unlink=True)
        bpy.data.meshes.remove(data)
    maximum_palm_displacement = max((vertex.co - before[vertex.index]).length for vertex in obj.data.vertices)
    split_evidence = None
    if settings.get('split_cuff'):
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        source_layer = mesh.faces.layers.int['_palm_source_surface']
        faces = [face for face in mesh.faces if face[source_layer]]
        edges = {edge for face in faces for edge in face.edges}
        vertices = {vertex for face in faces for vertex in face.verts}
        plane = inverse @ Vector((sign * head, 0, 0))
        normal = obj.matrix_world.to_3x3().transposed() @ Vector((1, 0, 0))
        result = bmesh.ops.bisect_plane(mesh, geom=[*vertices, *edges, *faces], dist=.000001,
                                        plane_co=plane, plane_no=normal, clear_outer=False, clear_inner=False)
        seam = [edge for edge in result['geom_cut'] if isinstance(edge, bmesh.types.BMEdge)]
        bmesh.ops.split_edges(mesh, edges=seam)
        mesh.to_mesh(obj.data)
        mesh.free()
        source_attribute = obj.data.attributes['_palm_source_surface']
        proximal = {index for face in obj.data.polygons if source_attribute.data[face.index].value
                    and all(abs((obj.matrix_world @ obj.data.vertices[index].co).x) <= head + .000001 for index in face.vertices)
                    for index in face.vertices}
        for index in proximal:
            for group in obj.vertex_groups:
                group.remove([index])
        group = obj.vertex_groups.get('lowerarm' + side) or obj.vertex_groups.new(name='lowerarm' + side)
        group.add(sorted(proximal), 1, 'REPLACE')
        split_evidence = {'plane_abs_x': head, 'seam_edges': len(seam), 'cuff_vertices': len(proximal),
                          'cuff_bone': 'lowerarm' + side, 'palm_bone': 'hand' + side}
    obj.data.update()
    normals = [normal.vector.copy() for normal in obj.data.corner_normals]
    sums = {}
    source_attribute = obj.data.attributes['_palm_source_surface']
    for face in obj.data.polygons:
        if not source_attribute.data[face.index].value:
            continue
        first, second, third = (obj.data.vertices[index].co for index in list(face.vertices)[:3])
        normal = (second - first).cross(third - first)
        for index in face.vertices:
            key = tuple(round(value, 6) for value in obj.data.vertices[index].co)
            sums[key] = sums.get(key, Vector()) + normal
    for face in obj.data.polygons:
        if source_attribute.data[face.index].value and all(abs((obj.matrix_world @ obj.data.vertices[index].co).x) >= head - .005 for index in face.vertices):
            for loop in face.loop_indices:
                point = obj.data.vertices[obj.data.loops[loop].vertex_index].co
                normals[loop] = sums[tuple(round(value, 6) for value in point)].normalized()
    obj.data.normals_split_custom_set(normals)
    parents = sorted({value.value - 1 for value in source_attribute.data if value.value})
    result_faces = sum(bool(value.value) for value in source_attribute.data)
    maximum_uv_error = 0
    if source_uv:
        from mathutils.interpolate import poly_3d_calc

        source_positions = obj.data.attributes['_clothing_source_position']
        uv_layer = obj.data.uv_layers.active
        for face in obj.data.polygons:
            parent = source_attribute.data[face.index].value - 1
            if parent not in source_uv:
                continue
            corners = source_uv[parent]
            for index, loop in zip(face.vertices, face.loop_indices):
                amounts = poly_3d_calc([point for point, _ in corners], source_positions.data[index].vector)
                expected = sum((uv * amount for (_, uv), amount in zip(corners, amounts)), Vector((0, 0)))
                maximum_uv_error = max(maximum_uv_error, (expected - uv_layer.data[loop].uv).length)
    obj.data.attributes.remove(source_attribute)
    return {'side': side, 'settings': settings, 'source_faces': len(component['faces']),
            'source_face_ids_retained': parents, 'result_faces': result_faces, 'palm_vertices': len(palm_indices),
            'maximum_palm_displacement': maximum_palm_displacement, 'split_cuff': split_evidence,
            'maximum_uv_interpolation_error': maximum_uv_error}


# 两身体的真实腕端各保原蒙皮，重叠薄片覆盖关节，裁边不生成横截面封盖。
def add_wrist_lining(job, rig, hand_surface):
    import bpy
    import bmesh
    from mathutils import Vector

    source, settings, side = job['object'], job['settings'], job['side']
    sign = 1 if side == '.l' else -1
    surfaces = {'human_hand': hand_surface, 'human_arm': hand_surface['arm_surface'],
                'skeleton_hand': hand_surface['skeleton_hand_surface'], 'skeleton_arm': hand_surface['skeleton_arm_surface']}
    parts, evidence = [], []
    for key, surface in surfaces.items():
        data = bpy.data.meshes.new('真实腕端内衬表面')
        triangles = [triangle for triangle in surface['triangles'] if all(surface['vertices'][index][0] * sign > 0 for index in triangle)]
        data.from_pydata(surface['vertices'], [], triangles)
        data.update()
        part = bpy.data.objects.new('真实腕端内衬表面', data)
        bpy.context.collection.objects.link(part)
        for index, weights in enumerate(surface['weights']):
            for name, amount in weights.items():
                group = part.vertex_groups.get(name) or part.vertex_groups.new(name=name)
                group.add([index], amount, 'REPLACE')
        mesh = bmesh.new()
        mesh.from_mesh(data)
        mesh.faces.index_update()
        source_points = mesh.verts.layers.float_vector.new('_lining_source_position')
        source_faces = mesh.faces.layers.int.new('_lining_source_triangle')
        for vertex in mesh.verts:
            vertex[source_points] = vertex.co
        for face in mesh.faces:
            face[source_faces] = face.index + 1
        deform = mesh.verts.layers.deform.active
        same_weights = {}
        for vertex in mesh.verts:
            identity = tuple(sorted(vertex[deform].items()))
            same_weights.setdefault(identity, []).append(vertex)
        # 仅焊接同权重的UV拆点，不能把同位置的手骨与腕骨合并成混合权重。
        for vertices in same_weights.values():
            bmesh.ops.remove_doubles(mesh, verts=vertices, dist=.000001)
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.normal_update()
        for vertex in mesh.verts:
            vertex.co += vertex.normal * settings['offset']
        lower, upper = settings['bounds']
        for bound, clear_inner, clear_outer in [(lower, True, False), (upper, False, True)]:
            bmesh.ops.bisect_plane(mesh, geom=[*mesh.verts, *mesh.edges, *mesh.faces], dist=.000001,
                                  plane_co=Vector((sign * bound, 0, 0)), plane_no=Vector((sign, 0, 0)),
                                  clear_inner=clear_inner, clear_outer=clear_outer)
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.normal_update()
        mesh.to_mesh(data)
        mesh.free()
        from mathutils.interpolate import poly_3d_calc

        original_points = data.attributes['_lining_source_position']
        original_faces = data.attributes['_lining_source_triangle']
        maximum_source_weight_error = 0
        maximum_original_weight_error = 0
        for face in data.polygons:
            triangle = triangles[original_faces.data[face.index].value - 1]
            corners = [Vector(surface['vertices'][index]) for index in triangle]
            for index in face.vertices:
                amounts = poly_3d_calc(corners, original_points.data[index].vector)
                expected = {}
                for origin, amount in zip(triangle, amounts):
                    for name, weight in surface['weights'][origin].items():
                        expected[name] = expected.get(name, 0) + amount * weight
                actual = {part.vertex_groups[group.group].name: group.weight for group in data.vertices[index].groups}
                maximum_source_weight_error = max(maximum_source_weight_error,
                    max(abs(expected.get(name, 0) - actual.get(name, 0)) for name in expected.keys() | actual.keys()))
                for origin in triangle:
                    if tuple(original_points.data[index].vector) == tuple(surface['vertices'][origin]):
                        expected_original = surface['weights'][origin]
                        maximum_original_weight_error = max(maximum_original_weight_error,
                            max(abs(expected_original.get(name, 0) - actual.get(name, 0)) for name in expected_original.keys() | actual.keys()))
        data.attributes.remove(original_points)
        data.attributes.remove(data.attributes['_lining_source_triangle'])
        data.materials.append(job['material'])
        uv = data.uv_layers.new(name=job['uv_layer'])
        for face in data.polygons:
            face.use_smooth = True
            for loop in face.loop_indices:
                uv.data[loop].uv = job['uv']
        part.modifiers.new('真实腕端原蒙皮', 'ARMATURE').object = rig
        parts.append(part)
        evidence.append({'source': key, 'source_vertices': len(surface['vertices']), 'faces': len(data.polygons),
                         'vertices': len(data.vertices), 'offset': settings['offset'], 'bounds': settings['bounds'],
                         'weight_method': 'original-skin-weights-with-Blender-deform-layer-interpolation',
                         'maximum_source_weight_error': maximum_source_weight_error,
                         'maximum_original_weight_error': maximum_original_weight_error,
                         'maximum_weight_sum_error': max(abs(sum(group.weight for group in vertex.groups) - 1) for vertex in data.vertices)})
    bpy.ops.object.select_all(action='DESELECT')
    source.select_set(True)
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.join()
    return {'side': side, 'material': job['material'].name, 'uv': list(job['uv']), 'parts': evidence}


# 组件选择只用来源事实；前面的矩阵不会改变后面选择的来源语义。
def select_components(components, selector, rig):
    return [component for component in components
            if (not selector.get('nodes') or bool({component['object'].name, component['object'].name.split('.')[0], re.sub(r'[^A-Za-z0-9_-]', '', component['object'].name)} & set(selector['nodes'])))
            and (not selector.get('face_count') or component.get('source_face_count', len(component['faces'])) == selector['face_count'])
            and (not selector.get('materials') or set(component['materials']) <= set(selector['materials']))
            and (not selector.get('bone_region') or component_region(component['center'], rig) in ([selector['bone_region']] if isinstance(selector['bone_region'], str) else selector['bone_region']))]


# 只写映射涉及的组；按原快照同时转移，既有目标权重一起累加，不重归一其他骨骼。
def remap_vertex_weights(obj, index, mapping):
    before = {obj.vertex_groups[group.group].name: group.weight for group in obj.data.vertices[index].groups}
    if not any(source != target and before.get(source, 0) > 0 for source, target in mapping.items()):
        return False
    after = {}
    for name, amount in before.items():
        target = mapping.get(name, name)
        after[target] = after.get(target, 0) + amount
    for name in sorted(set(mapping) | set(mapping.values())):
        group = obj.vertex_groups.get(name)
        if after.get(name, 0) > 0:
            group = group or obj.vertex_groups.new(name=name)
            group.add([index], after[name], 'REPLACE')
        elif group is not None:
            group.remove([index])
    return True


# 单一矩阵作用于完整衣片及同组扣件，内外层的开口和相对厚度一起保留。
def fit_upper_clothing(objects, rig, adjustments=(), hand_objects=(), hand_surface: HandSurface | None = None):
    from mathutils import Matrix, Vector

    for adjustment in adjustments:
        for target in adjustment.get('weight_remap', {}).values():
            if target not in rig.data.bones:
                raise ValueError('衣物权重映射目标骨不存在：' + target)
        z_bounds = (adjustment.get('transform_weight') or {}).get('z_bounds')
        if z_bounds is not None and (len(z_bounds) != 2 or not all(isfinite(value) for value in z_bounds) or z_bounds[0] == z_bounds[1]):
            raise ValueError('衣物Z渐变范围必须由两个不同的有限高度组成')
        settings = adjustment.get('arm_surface_fit')
        if settings:
            if not hand_surface or not hand_surface.get('arm_surface'):
                raise ValueError('肩帽适配需要本轮真实肩臂表面')
            for name in ['refine_abs_x', 'fit_abs_x', 'fit_z']:
                bounds = settings[name]
                if len(bounds) != 2 or not all(isfinite(value) for value in bounds) or bounds[1] <= bounds[0]:
                    raise ValueError('肩帽适配范围必须包含递增的两个有限数值：' + name)
            strength = settings.get('strength', 1)
            if not isfinite(strength) or not 0 < strength <= 1:
                raise ValueError('肩帽混合强度必须为大于0且不超过1的有限数值')
            if not isinstance(settings['subdivisions'], int) or settings['subdivisions'] < 0:
                raise ValueError('肩帽细分次数必须是非负整数')
            if not isfinite(settings['offset']) or settings['offset'] < 0 or not isfinite(settings['refine_min_z']):
                raise ValueError('肩帽间隙与细分高度必须有效，间隙不能为负')
    initial_faces = sum(len(obj.data.polygons) for obj in objects)
    palm_reports = []
    lining_jobs = {}
    components = [component for obj in objects for component in mesh_components(obj)]
    source_points = {obj: [obj.matrix_world @ vertex.co for vertex in obj.data.vertices] for obj in objects}
    palm_adjustments = [adjustment for adjustment in adjustments if adjustment.get('palm_surface_fit')]
    if palm_adjustments:
        if hand_surface is None:
            raise ValueError('闭拳适配需要本轮真实裸手表面')
        # 真实来源编号和源位置经Blender数据层插值传给新增面/点，后续选择仍遵循源组件。
        for obj in objects:
            identities = obj.data.attributes.new('_clothing_component_id', 'INT', 'FACE')
            positions = obj.data.attributes.new('_clothing_source_position', 'FLOAT_VECTOR', 'POINT')
            for vertex, point in zip(obj.data.vertices, source_points[obj]):
                positions.data[vertex.index].vector = point
            for identity, component in enumerate(components, 1):
                if component['object'] == obj:
                    component['source_id'] = identity
                    component['source_face_count'] = len(component['faces'])
                    for index in component['faces']:
                        identities.data[index].value = identity
        # 用原组件编号收集细分后的面，中心、材质与原面数保持源语义。
        def refresh(component):
            obj = component['object']
            identities = obj.data.attributes['_clothing_component_id']
            faces = [face.index for face in obj.data.polygons if identities.data[face.index].value == component['source_id']]
            return {**component, 'faces': faces, 'vertices': sorted({index for face in faces for index in obj.data.polygons[face].vertices})}
        for adjustment in palm_adjustments:
            for component in select_components(components, adjustment['selector'], rig):
                live = refresh(component)
                lining = adjustment['palm_surface_fit'].get('wrist_lining')
                if lining:
                    obj = component['object']
                    face = obj.data.polygons[live['faces'][0]]
                    layer = obj.data.uv_layers.active
                    lining_jobs[(obj, component['source_id'])] = {'object': obj, 'settings': lining,
                        'side': '.l' if component['center'].x >= 0 else '.r', 'material': obj.data.materials[face.material_index],
                        'uv_layer': layer.name, 'uv': layer.data[face.loop_indices[0]].uv.copy()}
                palm_reports.append(fit_palm_surface(live, rig, adjustment['palm_surface_fit'], hand_surface))
        components = [refresh(component) for component in components]
        for obj in objects:
            source_points[obj] = [value.vector.copy() for value in obj.data.attributes['_clothing_source_position'].data]
            obj.data.attributes.remove(obj.data.attributes['_clothing_component_id'])
            obj.data.attributes.remove(obj.data.attributes['_clothing_source_position'])
    operations = []
    arm_jobs = []
    geometry_operations = False
    openings = {}
    mixed_faces = {obj: set() for obj in objects}
    normals = {obj: [normal.vector.copy() for normal in obj.data.corner_normals] for obj in objects}
    for adjustment in adjustments:
        if adjustment.get('palm_surface_fit'):
            continue
        selector = adjustment['selector']
        selected = select_components(components, selector, rig)
        if adjustment.get('arm_surface_fit'):
            arm_jobs.append((selected, adjustment['arm_surface_fit']))
            continue
        weight_only = 'weight_remap' in adjustment and not any(name in adjustment for name in
            ['scale', 'translation', 'center_on_axis', 'align_on_axis', 'transform_from_bone', 'transform_weight'])
        for sign, side in [(1, '.l'), (-1, '.r')]:
            group = [component for component in selected if (component['center'].x >= 0) == (sign > 0)]
            if not group:
                continue
            geometry_operations |= not weight_only
            if adjustment.get('cuff_opening'):
                for component in group:
                    if component['object'] in hand_objects:
                        raise ValueError('独立手套不能作为臂筒开孔')
                    openings[id(component)] = {**component, 'opening': adjustment['cuff_opening']}
            points = [component['object'].matrix_world @ component['object'].data.vertices[index].co for component in group for index in component['vertices']]
            center = Vector(tuple((min(point[axis] for point in points) + max(point[axis] for point in points)) / 2 for axis in range(3)))
            axis = arm_axis_at_x(rig, side, center.x)
            source_pivot = center if adjustment.get('center_on_axis') else axis
            target_pivot = axis
            scale = adjustment.get('scale', [1, 1, 1])
            translation = Vector(adjustment.get('translation', [0, 0, 0]))
            translation.x *= sign
            rotation = component_axis_rotation(group, rig, side, center, adjustment['align_on_axis']) if adjustment.get('align_on_axis') else Matrix.Identity(4)
            matrix = Matrix.Translation(target_pivot + translation) @ Matrix.Diagonal((*scale, 1)) @ rotation @ Matrix.Translation(-source_pivot)
            transition = adjustment.get('transform_weight')
            if transition:
                start = transition['from_abs_x']
                end = max(abs(point.x) for point in points) if transition['to_abs_x'] == 'component_end' else transition['to_abs_x']
                if end <= start:
                    raise ValueError('袖口渐变结束位置必须超过入口')
                z_bounds = transition.get('z_bounds')
            maximum_displacement, rebound, remapped = 0, 0, 0
            for component in group:
                obj = component['object']
                local = obj.matrix_world.inverted() @ matrix @ obj.matrix_world
                normal_matrix = local.to_3x3().inverted().transposed()
                transformed = set()
                vertex_normals = {}
                for index in component['vertices']:
                    vertex = obj.data.vertices[index]
                    before = obj.matrix_world @ vertex.co
                    transform = not weight_only
                    if adjustment.get('transform_from_bone'):
                        boundary = rig.matrix_world @ rig.data.bones[adjustment['transform_from_bone'] + side].head_local
                        transform = abs(source_points[obj][index].x) >= abs(boundary.x)
                    if transform:
                        if transition:
                            first, last = transition['values']
                            amount = max(0, min(1, (abs(before.x) - start) / (end - start)))
                            weight = first + (last - first) * amount
                            if z_bounds is not None:
                                x_weight = weight
                                z_weight = max(0, min(1, (z_bounds[1] - before.z) / (z_bounds[1] - z_bounds[0])))
                                weight *= z_weight
                            delta = matrix @ before - before
                            vertex.co = obj.matrix_world.inverted() @ (before + delta * weight)
                            jacobian = Matrix.Identity(3) + (matrix.to_3x3() - Matrix.Identity(3)) * weight
                            inside_x = start <= abs(before.x) <= end if z_bounds is None else start < abs(before.x) < end
                            if inside_x:
                                derivative = (last - first) * (1 if before.x > 0 else -1) / (end - start)
                                if z_bounds is not None:
                                    derivative *= z_weight
                                for row in range(3):
                                    jacobian[row][0] += delta[row] * derivative
                            if z_bounds is not None and min(z_bounds) < before.z < max(z_bounds):
                                derivative = -x_weight / (z_bounds[1] - z_bounds[0])
                                for row in range(3):
                                    jacobian[row][2] += delta[row] * derivative
                            local_jacobian = obj.matrix_world.to_3x3().inverted() @ jacobian @ obj.matrix_world.to_3x3()
                            vertex_normals[index] = local_jacobian.inverted().transposed()
                        else:
                            vertex.co = local @ vertex.co
                        transformed.add(index)
                    maximum_displacement = max(maximum_displacement, ((obj.matrix_world @ vertex.co) - before).length)
                    if adjustment.get('bind_bone') or adjustment.get('bind_weights'):
                        if adjustment.get('bind_from_bone'):
                            boundary = rig.matrix_world @ rig.data.bones[adjustment['bind_from_bone'] + side].head_local
                            if abs(source_points[obj][index].x) < abs(boundary.x):
                                continue
                        for vertex_group in obj.vertex_groups:
                            vertex_group.remove([index])
                        declared = adjustment.get('bind_weights') or {adjustment['bind_bone']: 1.0}
                        total = sum(declared.values())
                        for name, amount in declared.items():
                            target = name if name in rig.data.bones else name + side
                            vertex_group = obj.vertex_groups.get(target) or obj.vertex_groups.new(name=target)
                            vertex_group.add([index], amount / total, 'REPLACE')
                        rebound += 1
                    if adjustment.get('weight_remap'):
                        remapped += remap_vertex_weights(obj, index, adjustment['weight_remap'])
                for index in component['faces']:
                    face = obj.data.polygons[index]
                    active = set(face.vertices) & transformed
                    if active and len(active) != len(face.vertices):
                        mixed_faces[obj].add(index)
                    elif active:
                        for loop in face.loop_indices:
                            correction = vertex_normals.get(obj.data.loops[loop].vertex_index, normal_matrix)
                            normals[obj][loop] = (correction @ normals[obj][loop]).normalized()
            operations.append({'side': side, 'selector': selector, 'matrix': [list(row) for row in matrix],
                               'components': len(group), 'faces': sum(len(component['faces']) for component in group),
                               'vertices': sum(len(component['vertices']) for component in group),
                               'maximum_displacement': maximum_displacement, 'rebound_vertices': rebound,
                               'weight_remap': adjustment.get('weight_remap'), 'remapped_vertices': remapped})
    for obj in objects:
        obj.data.update()
        if operations and geometry_operations:
            for index in mixed_faces[obj]:
                face = obj.data.polygons[index]
                for loop in face.loop_indices:
                    normals[obj][loop] = obj.data.vertices[obj.data.loops[loop].vertex_index].normal.copy() if face.use_smooth else face.normal.copy()
            obj.data.normals_split_custom_set(normals[obj])
    arm_reports = []
    for selected, settings in arm_jobs:
        reports = fit_arm_surface(selected, settings, hand_surface['arm_surface'])
        arm_reports.extend(reports)
        # 细分在旧矩阵之后；按原面映射更新尚未执行的开孔与肩帽选择，避免索引失效。
        for report in reports:
            for component in [*components, *openings.values()]:
                obj = component['object']
                if obj.name != report['object']:
                    continue
                old_faces = set(component['faces'])
                component['faces'] = [index for index, parent in enumerate(report['source_face_ids']) if parent in old_faces]
                component['vertices'] = sorted({index for face in component['faces'] for index in obj.data.polygons[face].vertices})
    opening_report = []
    if openings:
        specification = importlib.util.spec_from_file_location('modular_cuff_opening', ROOT / 'scripts/modular-character-cuff-opening.py')
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        opening_report = module.open_cuff_components(list(openings.values()), rig)
    lining_reports = [add_wrist_lining(job, rig, hand_surface) for job in lining_jobs.values()]
    return {'method': 'source-component-affine-fit', 'operations': operations,
            'cuff_opening': opening_report, 'palm_surface_fit': palm_reports, 'wrist_lining': lining_reports,
            **({'arm_surface_fit': arm_reports} if arm_reports else {}),
            'faces_before': initial_faces,
            'faces_after': sum(len(obj.data.polygons) for obj in objects)}


# 候选GLB只写隔离目录，同名身体和动作从来源目录以链接复用。
def build_candidate(catalog_path, asset_directory, output, adjustments_path, hand_model=None):
    import bpy

    output = output.resolve()
    if output.is_relative_to(ROOT / 'internal'):
        raise ValueError('服装候选输出不得写入正式素材目录')
    output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(catalog_path.read_text())
    adjustments = json.loads(adjustments_path.read_text())
    hand_surface = None
    if hand_model:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(hand_model))
        hand_surface = capture_hand_surface(bpy.data.objects['body_hands'])
        hand_surface['arm_surface'] = capture_hand_surface(bpy.data.objects['body_arms'])
        skeleton = next(body for body in catalog['characters'] if body['character_key'] == 'kaykit-skeleton-v1')
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(asset_directory / (skeleton['model_asset_key'] + '.glb')))
        hand_surface['skeleton_hand_surface'] = capture_hand_surface(bpy.data.objects['body_hands'])
        hand_surface['skeleton_arm_surface'] = capture_hand_surface(bpy.data.objects['body_arms'])
    uppers = [item for item in catalog['wearables'] if item['wearable_key'] in adjustments]
    reports = []
    for key in dict.fromkeys(item['model_asset_key'] for item in uppers):
        path = asset_directory / (key + '.glb')
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
        objects = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        rig.animation_data_clear()
        rig.data.pose_position = 'REST'
        for item in uppers:
            if item['model_asset_key'] == key:
                result = fit_upper_clothing([objects[name] for name in item['nodes']], rig, adjustments[item['wearable_key']], hand_surface=hand_surface)
                reports.append({'wearable_key': item['wearable_key'], **result})
        bpy.ops.object.select_all(action='DESELECT')
        for obj in [rig, *objects.values()]:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.export_scene.gltf(filepath=str(output / (key + '.glb')), export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_def_bones=False)
    for path in asset_directory.glob('*.glb'):
        target = output / path.name
        if not target.exists():
            target.symlink_to(path.resolve())
    (output / 'clothing-fit-report.json').write_text(json.dumps(reports, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--adjustments', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--hand-model', type=Path, help='本次身体候选GLB，仅闭掌适配时提供，目标节点为body_hands')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    build_candidate(args.catalog, args.assets, args.output, args.adjustments, args.hand_model)
