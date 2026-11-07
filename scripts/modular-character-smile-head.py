"""把巡林客的脸和头皮合成同一张连续的圆头表面。"""
import bmesh
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


# 在标准骨架空间定轮廓，下端接颈，上端沿用原有头饰空间。
CENTER = Vector((0, 0, 1.677))
RADII = Vector((0.429, 0.445, 0.433))
SCALP_POLE = Vector((0, 1, 1)).normalized()


def direction(point):
    """把标准骨架坐标转为椭球上的方向。"""
    return Vector(tuple((point[i] - CENTER[i]) / RADII[i] for i in range(3))).normalized()


def point_on_head(unit):
    """把单位方向换回标准骨架坐标。"""
    point = CENTER + Vector(tuple(unit[i] * RADII[i] for i in range(3)))
    # 下巴留一段很浅的圆底，与原低面数网格和颈部接触面相接。
    point.z += 0.016 * max(0, (-unit.z - 0.86) / 0.14)
    return point


def rounded_point(point):
    """保留唇线的浅凹凸，其余皮肤使用统一轮廓。"""
    rounded = point_on_head(direction(point))
    # 嘴唇和口腔整体向圆头表面移动，避免径向投影把上下唇和口腔压在一起。
    return rounded.lerp(point + Vector((0, 0.071, 0)), mouth_weight(point))


def mouth_weight(point):
    """完整保留嘴部近景，向周围脸颊及下巴渐变。"""
    if point.y >= -0.3:
        return 0
    width = min(1, max(0, (0.24 - abs(point.x)) / 0.08))
    height = min(1, max(0, (0.072 - abs(point.z - 1.427)) / 0.04))
    return width * height


def rounded_normal(point):
    """两份导出网格使用同一椭球法线，接边没有光照跳变。"""
    return Vector(tuple((point[i] - CENTER[i]) / RADII[i] ** 2 for i in range(3))).normalized()


def boundary_rim(mesh, shell):
    """按焊接位置提取原脸外边，并记下沿边的贴图坐标。"""
    surface = bmesh.new()
    surface.from_mesh(mesh)
    surface.faces.index_update()
    bmesh.ops.delete(surface, geom=[face for face in surface.faces if face.index not in shell], context='FACES')
    bmesh.ops.remove_doubles(surface, verts=list(surface.verts), dist=0.0005)
    surface.verts.index_update()
    uv = surface.loops.layers.uv.active
    loops = [edge.link_loops[0] for edge in surface.edges if edge.is_boundary]
    rim = {}
    for loop in sorted(loops, key=lambda loop: loop.vert.index):
        rim[loop.vert.index] = (loop.link_loop_next.vert.index, loop.vert.co.copy(), loop[uv].uv.copy())
    surface.free()
    ordered = []
    start = min(rim)
    cursor = start
    while cursor in rim:
        cursor, point, uv = rim.pop(cursor)
        ordered.append((point, uv))
    if cursor != start or rim or len(ordered) < 3:
        raise ValueError('巡林客脸部须有一条完整的头皮接边')
    return ordered


def fill_scalp(mesh, rim, material, uv_name):
    """从接边向后上方封口，沿用接边的肤色贴图。"""
    directions = [direction(point) for point, _ in rim]
    center_uv = sum((uv for _, uv in rim), Vector((0, 0))) / len(rim)
    positions = [rounded_point(point) for point, _ in rim]
    uvs = [uv for _, uv in rim]
    rings = 5
    for ring in range(1, rings):
        ratio = ring / rings
        for index, unit in enumerate(directions):
            positions.append(point_on_head(unit.slerp(SCALP_POLE, ratio)))
            uvs.append(rim[index][1].lerp(center_uv, ratio))
    pole = len(positions)
    positions.append(point_on_head(SCALP_POLE))
    uvs.append(center_uv)
    width = len(rim)
    faces = []
    for row in range(rings - 1):
        for index in range(width):
            start = row * width
            next_index = (index + 1) % width
            faces.append((start + next_index, start + index, start + width + index, start + width + next_index))
    start = (rings - 1) * width
    faces.extend((start + (index + 1) % width, start + index, pole) for index in range(width))
    mesh.from_pydata(positions, [], faces)
    mesh.materials.append(material)
    mesh.update()
    uv = mesh.uv_layers.new(name=uv_name)
    for loop in mesh.loops:
        uv.data[loop.index].uv = uvs[loop.vertex_index]
    for face in mesh.polygons:
        face.use_smooth = True
    mesh.normals_split_custom_set_from_vertices([rounded_normal(point) for point in positions])


def brow_faces(hair, connected_faces):
    """巡林客原头饰混有两条眉毛，按相对眼睛的位置取出两件。"""
    brows = []
    for component in connected_faces(hair):
        points = [hair.matrix_world @ hair.data.vertices[index].co
                  for face_index in component for index in hair.data.polygons[face_index].vertices]
        one_side = min(point.x for point in points) > 0.05 or max(point.x for point in points) < -0.05
        if one_side and min(point.z for point in points) > 1.64 and max(point.z for point in points) < 1.9:
            brows.append(component)
    if len(brows) != 2:
        raise ValueError('巡林客头饰须包含两条独立眉毛')
    return brows[0] | brows[1]


def fit_front(object_, indices, old_surface, new_surface, min_height):
    """沿前后方向把眉毛或胡须贴到新轮廓，保留原本的色块和厚度。"""
    front = Vector((0, 1, 0))
    inverse = object_.matrix_world.inverted()
    for index in indices:
        vertex = object_.data.vertices[index]
        point = object_.matrix_world @ vertex.co
        probe = Vector((point.x, -1, max(min_height, point.z)))
        old, _, _, _ = old_surface.ray_cast(probe, front)
        new, _, _, _ = new_surface.ray_cast(probe, front)
        if old is None or new is None:
            raise ValueError('巡林客五官超出可贴合的面部范围')
        point.y += new.y - old.y
        vertex.co = inverse @ point
    object_.data.update()


def beard_faces(headwear, connected_faces):
    """短发与胡须属于同一穿戴项，只移动下巴和嘴边的独立部件。"""
    beard = set()
    for component in connected_faces(headwear):
        indices = {vertex for face in component for vertex in headwear.data.polygons[face].vertices}
        if max((headwear.matrix_world @ headwear.data.vertices[index].co).z for index in indices) < 1.55:
            beard.update(component)
    return beard


def fit_beard(headwear, face_head, connected_faces):
    """把巡林客原头饰里的胡须贴回新嘴角和下巴。"""
    shell = max(connected_faces(face_head), key=len)
    skin = [tuple(face.vertices) for face in face_head.data.polygons if face.index in shell]
    points = [face_head.matrix_world @ vertex.co for vertex in face_head.data.vertices]
    original = BVHTree.FromPolygons(points, skin)
    rounded = BVHTree.FromPolygons([rounded_point(point) for point in points], skin)
    beard = sorted({vertex for face in beard_faces(headwear, connected_faces) for vertex in headwear.data.polygons[face].vertices})
    fit_front(headwear, beard, original, rounded, 1.37)
    return len(beard)


def reshape(face_head, face_scalp, connected_faces, bind, *, brows):
    """保留五官和耳朵，在原面部接边重建头皮并绑定到头骨。"""
    import bpy

    bind(face_head, 'head')
    mesh = face_head.data
    components = sorted(connected_faces(face_head), key=lambda component: (-len(component), min(component)))
    shell = components[0]
    skin = [face for face in mesh.polygons if face.index in shell]
    skin_vertices = {vertex for face in skin for vertex in face.vertices}
    source_points = [vertex.co.copy() for vertex in mesh.vertices]
    source_normals = [normal.vector.copy() for normal in mesh.corner_normals]
    rim = boundary_rim(mesh, shell)
    skin_polygons = [tuple(face.vertices) for face in skin]
    source_surface = BVHTree.FromPolygons(source_points, skin_polygons)
    for component in components[1:]:
        indices = sorted({vertex for face_index in component for vertex in mesh.polygons[face_index].vertices})
        center = sum((source_points[index] for index in indices), Vector()) / len(indices)
        attachment, _, _, _ = source_surface.find_nearest(center)
        shift = rounded_point(attachment) - attachment
        for index in indices:
            mesh.vertices[index].co += shift
    for index in skin_vertices:
        mesh.vertices[index].co = rounded_point(source_points[index])
    for face in skin:
        face.use_smooth = True
        for index in face.loop_indices:
            vertex = mesh.loops[index].vertex_index
            normal = rounded_normal(mesh.vertices[vertex].co)
            source_normals[index] = normal.lerp(source_normals[index], mouth_weight(source_points[vertex])).normalized()
    mesh.update()
    mesh.normals_split_custom_set(source_normals)

    # 丢弃原来藏在脸后的整球，只保留与新脸共用接边的封口。
    old_mesh = face_scalp.data
    face_scalp.data = bpy.data.meshes.new('face_scalp_mesh')
    face_scalp.matrix_world = Matrix.Identity(4)
    fill_scalp(face_scalp.data, rim, mesh.materials[skin[0].material_index], mesh.uv_layers.active.name)
    bind(face_scalp, 'head')
    if old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)
    evidence = {
        'method': 'rounded-head-with-shared-rim',
        'rim_vertices': len(rim),
        'skin_faces': len(skin) + len(face_scalp.data.polygons),
        'preserved_feature_faces': len(mesh.polygons) - len(skin),
    }
    bind(brows, 'head')
    rounded_surface = BVHTree.FromPolygons([vertex.co for vertex in mesh.vertices], skin_polygons)
    fit_front(brows, range(len(brows.data.vertices)), source_surface, rounded_surface, 0)
    evidence['preserved_brow_faces'] = len(brows.data.polygons)
    return face_head, face_scalp, evidence
