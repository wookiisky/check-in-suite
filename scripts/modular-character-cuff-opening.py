"""以真实骨轴给明确标注的金属臂筒开孔，保留源外壁和独立装饰件。"""
from __future__ import annotations

from collections import Counter
import math
from typing import TYPE_CHECKING, NotRequired, TypedDict

if TYPE_CHECKING:
    from bpy.types import Object


# 内衬严格位于来源实心臂筒内部，接触面允许被身体覆盖。
class CuffLiningSettings(TypedDict):
    radii: list[float]  # 孔口内衬的椭圆半径。
    contact_radii: list[float]  # 中部接触环的椭圆半径。
    axis_offset: float  # 接触环相对原臂筒中心的轴向偏移。
    thickness: float  # 柔性内衬的薄壁厚度。
    color: list[float]  # 配置提供的RGBA材质色。


# 只用于经来源核对的臂筒；闭合拳套不进入该制作操作。
class CuffOpeningSettings(TypedDict):
    bone: str  # 真实前臂或上臂骨轴，不含左右后缀。
    radii: list[float]  # 通孔在前后、上下方向的椭圆半径，单位米。
    lining: NotRequired[CuffLiningSettings]  # 只为经审核的闭合金属臂筒增加内部支撑。
    wall_thickness: NotRequired[float]  # 已审核开放袖管向内增加的薄壁，不用于独立装饰。


# 来源面索引在所有矩阵完成前保持冻结，开孔时一次性复制全部目标。
class CuffComponent(TypedDict):
    object: Object  # 调用方持有的上装对象，完成后保持对象身份不变。
    faces: list[int]  # 原始完整连通件的面，不依赖变形后的坐标重新猜选。
    opening: NotRequired[CuffOpeningSettings]  # 同一上装有不同骨轴时逐组件覆盖设置。


# UV或法线拆开的同位置顶点只在拓扑核对时焊接，不改源坐标与属性。
def topology(obj):
    position = lambda index: tuple(round(value, 6) for value in obj.data.vertices[index].co)
    points = {position(vertex.index) for vertex in obj.data.vertices}
    edges = Counter(tuple(sorted((position(first), position(second))))
                    for face in obj.data.polygons for first, second in face.edge_keys)
    return {'vertices': len(points), 'faces': len(obj.data.polygons),
            'euler': len(points) - len(edges) + len(obj.data.polygons),
            'boundary_edges': sum(count == 1 for count in edges.values()),
            'non_manifold_edges': sum(count > 2 for count in edges.values())}


# 只删未选面及孤点，源UV、材质槽和变形权重由Blender原生数据层保留。
def keep_faces(obj, selected):
    import bmesh

    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.faces.index_update()
    bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if face.index not in selected], context='FACES')
    bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
    mesh.to_mesh(obj.data)
    mesh.free()


# 同一真实骨轴供边界核对与孔刀具复用，不用局部包围盒冒充手臂方向。
def bone_frame(part, rig, name):
    from mathutils import Vector

    points = [part.matrix_world @ vertex.co for vertex in part.data.vertices]
    side = '.l' if sum(point.x for point in points) >= 0 else '.r'
    bone = rig.data.bones[name + side]
    origin = rig.matrix_world @ bone.head_local
    axis = ((rig.matrix_world @ bone.tail_local) - origin).normalized()
    midpoint = (min(point.x for point in points) + max(point.x for point in points)) / 2
    center = origin + axis * ((midpoint - origin.x) / axis.x)
    across = Vector((0, 1, 0))
    across = (across - axis * across.dot(axis)).normalized()
    up = axis.cross(across)
    return center, axis, across, up


# 袖口边界须绕骨轴一周；同材质的局部扣件边界绕数为零，保持原样。
def boundary_encircles_axis(part, rig, name):
    from mathutils import Vector

    center, _, across, up = bone_frame(part, rig, name)
    position = lambda index: tuple(round(value, 6) for value in part.data.vertices[index].co)
    edges = Counter(tuple(sorted((position(first), position(second))))
                    for face in part.data.polygons for first, second in face.edge_keys)
    boundary = {edge for edge, count in edges.items() if count == 1}
    neighbors = {}
    for first, second in boundary:
        neighbors.setdefault(first, set()).add(second)
        neighbors.setdefault(second, set()).add(first)
    if any(len(values) != 2 for values in neighbors.values()):
        return False
    while boundary:
        first, second = boundary.pop()
        loop = [first, second]
        while loop[-1] != first:
            current = loop[-1]
            following = next((point for point in neighbors[current]
                              if tuple(sorted((current, point))) in boundary), None)
            if following is None:
                return False
            boundary.remove(tuple(sorted((current, following))))
            loop.append(following)
        angles = []
        for point in loop:
            delta = part.matrix_world @ Vector(point) - center
            angles.append(math.atan2(delta.dot(up), delta.dot(across)))
        winding = sum((second - first + math.pi) % math.tau - math.pi
                      for first, second in zip(angles, angles[1:]))
        if abs(winding) > math.pi:
            return True
    return False


# 刀具封闭且沿真实骨轴贯穿，内壁沿用源金属材质；源外壁不做半径拉伸。
def cutter_for(part, rig, settings):
    import bpy

    center, axis, across, up = bone_frame(part, rig, settings['bone'])
    points = [part.matrix_world @ vertex.co for vertex in part.data.vertices]
    radius_y, radius_z = settings['radii']
    depth = max(point.dot(axis) for point in points) - min(point.dot(axis) for point in points) + .08
    segments = 48
    vertices = [center + axis * distance + across * (radius_y * math.cos(index * math.tau / segments))
                + up * (radius_z * math.sin(index * math.tau / segments))
                for distance in [-depth / 2, depth / 2] for index in range(segments)]
    faces = [(index, (index + 1) % segments, (index + 1) % segments + segments, index + segments)
             for index in range(segments)]
    faces.extend([tuple(reversed(range(segments))), tuple(range(segments, segments * 2))])
    mesh = bpy.data.meshes.new('臂筒通孔刀具')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for material in part.data.materials:
        mesh.materials.append(material)
    material_index = Counter(face.material_index for face in part.data.polygons).most_common(1)[0][0]
    for face in mesh.polygons:
        face.material_index = material_index
    cutter = bpy.data.objects.new('臂筒通孔刀具', mesh)
    bpy.context.collection.objects.link(cutter)
    return cutter, center, axis, across, up, depth


# 内部端盖、源保留面与新内壁分别计数；比较对象是拟合后但尚未开孔的原部件。
def opening_evidence(part, source_points, source_triangles, center, axis, across, up, depth, radii):
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    part.data.calc_loop_triangles()
    points = [part.matrix_world @ vertex.co for vertex in part.data.vertices]
    triangles = [tuple(triangle.vertices) for triangle in part.data.loop_triangles]
    tree = BVHTree.FromPolygons(points, triangles, all_triangles=True)
    original = BVHTree.FromPolygons(source_points, source_triangles, all_triangles=True)
    radius_y, radius_z = radii
    preserved = removed = lost = 0
    for triangle in source_triangles:
        corners = [source_points[index] for index in triangle]
        probes = corners + [(corners[index] + corners[(index + 1) % 3]) / 2 for index in range(3)]
        probes.append(sum(corners, Vector()) / 3)
        for point in probes:
            delta = point - center
            inside = (abs(delta.dot(axis)) < depth / 2 - .00001
                      and (delta.dot(across) / radius_y) ** 2 + (delta.dot(up) / radius_z) ** 2 < 1 - .00001)
            distance = tree.find_nearest(point)[3]
            if inside and distance > .00001:
                removed += 1
            elif not inside and distance > .00003:
                lost += 1
            else:
                preserved += 1
    if lost:
        raise ValueError(f'臂筒开孔改变了刀具以外的源表面：{lost} 个样本')
    inner = 0
    for triangle in triangles:
        center_point = sum((points[index] for index in triangle), Vector()) / 3
        inner += original.find_nearest(center_point)[3] > .00003
    return {'preserved_source_samples': preserved, 'removed_internal_samples': removed,
            'lost_external_samples': lost, 'new_inner_surface_triangles': inner}


# 布尔新增点不保证继承变形组；旧点精确保留，切口新点从真实源三角面插值。
def transfer_weights(part, source_points, source_triangles, source_weights):
    from mathutils.bvhtree import BVHTree
    from mathutils.interpolate import poly_3d_calc
    from mathutils.kdtree import KDTree

    tree = BVHTree.FromPolygons(source_points, source_triangles, all_triangles=True)
    vertices = KDTree(len(source_points))
    for index, point in enumerate(source_points):
        vertices.insert(point, index)
    vertices.balance()
    for vertex in part.data.vertices:
        point = part.matrix_world @ vertex.co
        _, index, distance = vertices.find(point)
        if distance < .000001:
            weights = source_weights[index]
        else:
            nearest, _, face, _ = tree.find_nearest(point)
            triangle = source_triangles[face]
            amounts = poly_3d_calc([source_points[index] for index in triangle], nearest)
            weights = {}
            for index, amount in zip(triangle, amounts):
                for name, weight in source_weights[index].items():
                    weights[name] = weights.get(name, 0) + weight * max(0, amount)
        total = sum(weights.values())
        if total <= .000001:
            raise ValueError('臂筒新增内壁没有有效的源骨骼权重')
        for group in part.vertex_groups:
            group.remove([vertex.index])
        for name, weight in weights.items():
            group = part.vertex_groups.get(name) or part.vertex_groups.new(name=name)
            group.add([vertex.index], weight / total, 'REPLACE')


# 对原闭筒求真实体积绕数；新内衬不能超出源外轮廓或长度。
def inside_source_volume(point, source_points, source_triangles):
    angle = 0.0
    for indices in source_triangles:
        first, second, third = [source_points[index] - point for index in indices]
        numerator = first.dot(second.cross(third))
        denominator = (first.length * second.length * third.length
                       + first.dot(second) * third.length + second.dot(third) * first.length
                       + third.dot(first) * second.length)
        angle += 2 * math.atan2(numerator, denominator)
    return abs(angle / (4 * math.pi)) > .5


# 孔沿由原始端盖的射线交点决定，暗衬收向中环且不移动任何原金属面。
def add_internal_lining(part, rig, settings, source_points, source_triangles):
    import bpy
    from mathutils.bvhtree import BVHTree

    lining = settings['lining']
    center, axis, across, up = bone_frame(part, rig, settings['bone'])
    center += axis * lining['axis_offset']
    tree = BVHTree.FromPolygons(source_points, source_triangles, all_triangles=True)
    segments, thickness = 16, lining['thickness']
    sections = [(-1, lining['radii']), (0, lining['contact_radii']), (1, lining['radii'])]
    vertices = []
    for layer in [0, 1]:
        for end, radii in sections:
            for index in range(segments):
                angle = index * math.tau / segments
                point = center + across * ((radii[0] + layer * thickness) * math.cos(angle))
                point += up * ((radii[1] + layer * thickness) * math.sin(angle))
                if end:
                    hit = tree.ray_cast(point + axis * end, axis * -end, 2)[0]
                    if hit is None:
                        raise ValueError('内衬孔沿未落在来源臂筒内部')
                    point = hit - axis * (end * thickness)
                vertices.append(point)
    outside = sum(not inside_source_volume(point, source_points, source_triangles) for point in vertices)
    if outside:
        raise ValueError(f'内衬超出来源臂筒外轮廓：{outside}个顶点')
    faces = []
    layer_size = len(sections) * segments
    for layer in [0, 1]:
        offset = layer * layer_size
        for row in range(len(sections) - 1):
            for index in range(segments):
                following = (index + 1) % segments
                face = (offset + row * segments + index, offset + row * segments + following,
                        offset + (row + 1) * segments + following, offset + (row + 1) * segments + index)
                faces.append(tuple(reversed(face)) if layer == 0 else face)
    for row in [0, len(sections) - 1]:
        for index in range(segments):
            following = (index + 1) % segments
            face = (row * segments + index, row * segments + following,
                    layer_size + row * segments + following, layer_size + row * segments + index)
            faces.append(face if row == 0 else tuple(reversed(face)))
    mesh = bpy.data.meshes.new('臂筒内部柔性衬层')
    mesh.from_pydata([part.matrix_world.inverted() @ point for point in vertices], [], faces)
    mesh.update()
    obj = bpy.data.objects.new('臂筒内部柔性衬层', mesh)
    bpy.context.collection.objects.link(obj)
    obj.matrix_world = part.matrix_world.copy()
    inward = True
    normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
    for face in mesh.polygons[:(len(sections) - 1) * segments]:
        point = obj.matrix_world @ face.center
        radial = point - center - axis * (point - center).dot(axis)
        inward = inward and (normal_matrix @ face.normal).dot(radial) < 0
    result = topology(obj)
    if not inward or result['euler'] != 0 or result['boundary_edges'] or result['non_manifold_edges']:
        bpy.data.objects.remove(obj, do_unlink=True)
        raise ValueError('内衬未形成法线向内的完整薄壁')
    material = bpy.data.materials.new('深灰柔性内衬')
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = lining['color']
    shader.inputs['Roughness'].default_value = .9
    mesh.materials.append(material)
    side = '.l' if center.x > 0 else '.r'
    obj.vertex_groups.new(name=settings['bone'] + side).add(list(range(len(vertices))), 1, 'REPLACE')
    for face in mesh.polygons:
        face.use_smooth = True
    bpy.ops.object.select_all(action='DESELECT')
    part.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = part
    bpy.ops.object.join()
    return {'role': 'authored-internal-flexible-lining', 'vertices': len(vertices), 'faces': len(faces),
            'outside_source_volume_vertices': outside, 'inner_surface_normals_inward': inward,
            'topology': result, 'settings': lining}


# 所有原部件先复制并验证，再统一替换源面，避免前一次布尔运算使下一组索引失效。
def open_cuff_components(components: list[CuffComponent], rig: Object, settings: CuffOpeningSettings | None = None):
    import bpy
    import bmesh

    parts, selected, reports, created_names = [], {}, [], []
    try:
        for component in components:
            source = component['object']
            faces = set(component['faces'])
            if selected.get(source, set()) & faces:
                raise ValueError('同一臂筒来源面不能重复开孔')
            part = source.copy()
            part.data = source.data.copy()
            part.name = '独立臂筒开孔件'
            bpy.context.collection.objects.link(part)
            created_names.append(part.name)
            keep_faces(part, faces)
            source_topology = topology(part)
            configuration = component.get('opening', settings)
            open_sleeve = (source_topology['boundary_edges'] and configuration is not None
                           and configuration.get('wall_thickness')
                           and boundary_encircles_axis(part, rig, configuration['bone']))
            if source_topology['non_manifold_edges'] or (source_topology['boundary_edges'] and not open_sleeve):
                bpy.data.objects.remove(part, do_unlink=True)
                reports.append({'status': 'retained-open-source', 'source_topology': source_topology})
                continue
            selected.setdefault(source, set()).update(faces)
            if configuration is None:
                raise ValueError('闭合臂筒缺少明确的骨轴与孔径配方')
            parts.append((source, part, configuration, source_topology))
        for source, part, configuration, source_topology in parts:
            for modifier in list(part.modifiers):
                part.modifiers.remove(modifier)
            part.data.calc_loop_triangles()
            source_points = [part.matrix_world @ vertex.co for vertex in part.data.vertices]
            source_triangles = [tuple(triangle.vertices) for triangle in part.data.loop_triangles]
            source_weights = [{part.vertex_groups[group.group].name: group.weight for group in vertex.groups}
                              for vertex in part.data.vertices]
            # glTF的UV/法线拆点不能变成各自加厚的三角薄块；loop UV仍单独保留。
            connected = bmesh.new()
            connected.from_mesh(part.data)
            bmesh.ops.remove_doubles(connected, verts=list(connected.verts), dist=.000001)
            bmesh.ops.recalc_face_normals(connected, faces=list(connected.faces))
            connected.to_mesh(part.data)
            connected.free()
            welded_vertices = len(source_points) - len(part.data.vertices)
            if source_topology['boundary_edges']:
                modifier = part.modifiers.new('源袖管向内薄壁', 'SOLIDIFY')
                modifier.thickness = configuration['wall_thickness']
                modifier.offset = -1
                modifier.use_even_offset = True
                modifier.use_rim = True
                bpy.ops.object.select_all(action='DESELECT')
                part.select_set(True)
                bpy.context.view_layer.objects.active = part
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            cutter, center, axis, across, up, depth = cutter_for(part, rig, configuration)
            try:
                modifier = part.modifiers.new('真实臂筒通孔', 'BOOLEAN')
                modifier.operation = 'DIFFERENCE'
                modifier.solver = 'EXACT'
                modifier.object = cutter
                bpy.ops.object.select_all(action='DESELECT')
                part.select_set(True)
                bpy.context.view_layer.objects.active = part
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            finally:
                bpy.data.objects.remove(cutter, do_unlink=True)
            result_topology = topology(part)
            if not part.data.polygons or result_topology['euler'] != 0 or result_topology['boundary_edges'] or result_topology['non_manifold_edges']:
                raise ValueError(f'臂筒开孔未得到闭合流形通孔：source={source.name}, source_topology={source_topology}, settings={configuration}, result={result_topology}')
            transfer_weights(part, source_points, source_triangles, source_weights)
            evidence = opening_evidence(part, source_points, source_triangles, center, axis, across, up, depth, configuration['radii'])
            lining_report = None
            if configuration.get('lining'):
                if source_topology['boundary_edges']:
                    raise ValueError('内部柔性衬层只用于已审核的来源闭筒')
                lining_report = add_internal_lining(part, rig, configuration, source_points, source_triangles)
            reports.append({'status': 'opened', 'bone': configuration['bone'], 'radii': configuration['radii'],
                            'welded_source_split_vertices': welded_vertices, 'lining': lining_report,
                            'solidify_wall_thickness': configuration.get('wall_thickness') if source_topology['boundary_edges'] else None,
                            'center': list(center), 'axis': list(axis), 'source_topology': source_topology,
                            'result_topology': result_topology, 'source_uv_layers': list(part.data.uv_layers.keys()), **evidence})
        for source, faces in selected.items():
            keep_faces(source, set(range(len(source.data.polygons))) - faces)
            bpy.ops.object.select_all(action='DESELECT')
            source.select_set(True)
            for original, part, _, _ in parts:
                if original == source:
                    part.select_set(True)
            bpy.context.view_layer.objects.active = source
            bpy.ops.object.join()
    except Exception:
        for name in created_names:
            part = bpy.data.objects.get(name)
            if part is not None:
                bpy.data.objects.remove(part, do_unlink=True)
        raise
    return reports
