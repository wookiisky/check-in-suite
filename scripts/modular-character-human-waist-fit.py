"""离线移除基础人体中遗留的裤装髋壳，保留原腿筒和腰部接口。"""

from pathlib import Path
import importlib.util
import math
from typing import TypedDict


class HumanWaistSettings(TypedDict):
    """替代裤壳的裸身横截面；原始腰口由真实几何读取。"""

    sections: list[list[float]]  # 从下往上的高度、左右半径及前后半径。
    segments: int  # 新髋壳的每圈顶点数。
    seam_height: float  # 不变的腿部与躯干接口高度。


# UV/法线会复制顶点，因此按真实位置识别连通件，不使用导入顺序。
def position_components(obj):
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    keys = [tuple(round(value, 5) for value in point) for point in points]
    parents = {key: key for key in keys}

    def root(key):
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key

    for face in obj.data.polygons:
        first = root(keys[face.vertices[0]])
        for index in face.vertices[1:]:
            parents[root(keys[index])] = first
    components = {}
    for face in obj.data.polygons:
        components.setdefault(root(keys[face.vertices[0]]), set()).add(face.index)
    return list(components.values())


# 仅body_legs的裤形组件被替换；下腿数据、骨架及其余节点都保持原样。
def fit_human_waist(objects, rig, settings: HumanWaistSettings):
    import bpy
    import bmesh
    from mathutils import Vector

    spec = importlib.util.spec_from_file_location(
        "_human_waist_body_mesh",
        Path(__file__).with_name("modular-character-body-shaping.py"),
    )
    shaping = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shaping)
    obj = objects["body_legs"]
    old = obj.data
    components = position_components(obj)
    # 真实腿筒含lowerleg权重；源裤壳/方扣只有hips/spine/chest，不混入身体腿段。
    leg_faces = set()
    for faces in components:
        vertices = {index for face in faces for index in old.polygons[face].vertices}
        if any(
            obj.vertex_groups[group.group].name.startswith("lowerleg.")
            and group.weight > 0.001
            for index in vertices
            for group in old.vertices[index].groups
        ):
            leg_faces.update(faces)
    if not leg_faces:
        raise ValueError("未找到带真实小腿蒙皮的腿筒")
    removed = set(range(len(old.polygons))) - leg_faces
    if not removed:
        raise ValueError("没有可替换的源裤形组件")
    used = sorted(
        {index for face in leg_faces for index in old.polygons[face].vertices}
    )
    into_world = obj.matrix_world
    inverse = into_world.inverted()

    # 原腿筒及腰口的蒙皮逐点复制，不从重建表面反推。
    def weights(vertex):
        return {obj.vertex_groups[g.group].name: g.weight for g in vertex.groups}

    mesh = shaping.BodyMesh()
    original = mesh.ring(
        [into_world @ old.vertices[i].co for i in used],
        [weights(old.vertices[i]) for i in used],
    )
    remap = dict(zip(used, original))
    old_faces = sorted(leg_faces)
    for index in old_faces:
        mesh.faces.append(tuple(remap[v] for v in old.polygons[index].vertices))
        mesh.regions.append("original-legs")
    seam = {}
    for vertex in old.vertices:
        point = into_world @ vertex.co
        if abs(point.z - settings["seam_height"]) < 1e-5:
            seam[tuple(round(value, 6) for value in point)] = (point, weights(vertex))
    if len(seam) < 8:
        raise ValueError("实际腰部接口不足以重建闭壳")
    lower = []
    for z, rx, ry in settings["sections"]:
        points = [
            Vector(
                (
                    rx * math.cos(i * math.tau / settings["segments"]),
                    ry * math.sin(i * math.tau / settings["segments"]),
                    z,
                )
            )
            for i in range(settings["segments"])
        ]
        # 新髋域保持原hips/spine过渡；原腰口权重逐点保留，不用近邻服装权重。
        spine = min(0.5, max(0, (z - 0.50) / (0.72 - 0.50) * 0.5))
        ring = mesh.ring(points, [{"hips": 1 - spine, "spine": spine}] * len(points))
        if lower:
            mesh.bridge(lower[-1], ring, "bare-hips")
        lower.append(ring)
    mesh.cap(lower[0], "bare-hips")
    waist = mesh.ring(
        [value[0] for value in seam.values()], [value[1] for value in seam.values()]
    )
    shaping.join_waist(mesh, lower[-1], waist)
    mesh.faces.append(
        tuple(
            sorted(
                waist, key=lambda i: math.atan2(mesh.points[i][1], mesh.points[i][0])
            )
        )
    )
    mesh.regions.append("bare-hips")
    data = bpy.data.meshes.new("body_legs_bare_waist_mesh")
    data.from_pydata([inverse @ Vector(point) for point in mesh.points], [], mesh.faces)
    for material in old.materials:
        data.materials.append(material)
    skin = objects["body_torso"].data.materials[0]
    skin_index = len(data.materials)
    data.materials.append(skin)
    data.update()
    # 只计算新壳的朝向；旧腿的每个角法线与UV逐项恢复。
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces)[len(old_faces) :])
    bm.to_mesh(data)
    bm.free()
    data.update()
    uv = data.uv_layers.new(
        name=old.uv_layers.active.name if old.uv_layers.active else "UVMap"
    )
    normals = [tuple(normal.vector) for normal in data.corner_normals]
    for new_index, old_index in enumerate(old_faces):
        source = old.polygons[old_index]
        target = data.polygons[new_index]
        target.material_index = source.material_index
        target.use_smooth = source.use_smooth
        for new_loop, old_loop in zip(target.loop_indices, source.loop_indices):
            if old.uv_layers.active:
                uv.data[new_loop].uv = old.uv_layers.active.data[old_loop].uv
            normals[new_loop] = tuple(old.corner_normals[old_loop].vector)
    for face in list(data.polygons)[len(old_faces) :]:
        face.material_index = skin_index
        face.use_smooth = True
    data.update()
    # 新壳使用平滑顶点法线，旧腿维持源法线。
    for face in list(data.polygons)[len(old_faces) :]:
        for loop in face.loop_indices:
            normals[loop] = tuple(data.vertices[data.loops[loop].vertex_index].normal)
    data.normals_split_custom_set(normals)
    obj.data = data
    obj.vertex_groups.clear()
    for index, skin_weights in enumerate(mesh.weights):
        for name, amount in skin_weights.items():
            group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
            group.add([index], amount, "REPLACE")
    return {
        "method": "replace-source-garment-hips-with-bare-profile",
        "settings": settings,
        "preserved_leg_faces": len(old_faces),
        "removed_garment_faces": len(removed),
        "waist_vertices": len(seam),
        "replaced_height_bounds": [
            min(
                (into_world @ v.co).z
                for v in old.vertices
                if any(v.index in old.polygons[f].vertices for f in removed)
            ),
            settings["seam_height"],
        ],
        "added_profile_vertices": len(data.vertices) - len(used),
    }
