"""为已审核的完整兜帽布面留出横截面余量，保留棕发、眼孔与蒙皮。"""

from typing import TypedDict


class HoodFitSettings(TypedDict):
    """完整绿布在标准头骨坐标中的离线适配参数。"""

    anchor_bone: str  # 尾端作为横截面缩放中心。
    scale_x: float  # 帽壳和面罩使用相同的左右缩放。
    scale_y: float  # 帽壳和面罩使用相同的前后缩放。
    cloth_uv_bounds: list[float]  # 来源审核确认的两块绿布图集区域。


# 两个来源布件采用同一仿射变换，保持它们的接口与眼部开口形状。
def fit_hood_cheeks(obj, rig, settings: HoodFitSettings) -> dict[str, object]:
    from mathutils import Matrix

    bone = rig.data.bones[settings["anchor_bone"]]
    anchor = rig.matrix_world @ bone.tail_local
    vertical = (
        (rig.matrix_world @ bone.tail_local) - (rig.matrix_world @ bone.head_local)
    ).normalized()
    lateral = (
        (rig.matrix_world @ rig.data.bones["upperarm.l"].head_local)
        - (rig.matrix_world @ rig.data.bones["upperarm.r"].head_local)
    ).normalized()
    posterior = vertical.cross(lateral).normalized()
    lateral = posterior.cross(vertical).normalized()
    basis = Matrix((lateral, posterior, vertical)).transposed().to_4x4()
    world_transform = (
        Matrix.Translation(anchor)
        @ basis
        @ Matrix.Diagonal((settings["scale_x"], settings["scale_y"], 1, 1))
        @ basis.inverted()
        @ Matrix.Translation(-anchor)
    )
    transform = obj.matrix_world.inverted() @ world_transform @ obj.matrix_world
    normal_transform = transform.to_3x3().inverted().transposed()
    mesh = obj.data
    low_u, high_u, low_v, high_v = settings["cloth_uv_bounds"]
    uv_layer = mesh.uv_layers.active
    cloth_faces = [
        face
        for face in mesh.polygons
        if low_u
        <= sum(uv_layer.data[i].uv.x for i in face.loop_indices)
        / len(face.loop_indices)
        < high_u
        and low_v
        <= sum(uv_layer.data[i].uv.y for i in face.loop_indices)
        / len(face.loop_indices)
        < high_v
    ]
    cloth_vertices = {index for face in cloth_faces for index in face.vertices}
    normals = [normal.vector.copy() for normal in mesh.corner_normals]
    moved, maximum = [], 0.0
    for index in sorted(cloth_vertices):
        vertex = mesh.vertices[index]
        before = vertex.co.copy()
        vertex.co = transform @ before
        distance = (obj.matrix_world @ vertex.co - obj.matrix_world @ before).length
        if distance > 0.0000001:
            moved.append(index)
            maximum = max(maximum, distance)
    for face in cloth_faces:
        for loop in face.loop_indices:
            normals[loop] = (normal_transform @ normals[loop]).normalized()
    mesh.update()
    mesh.normals_split_custom_set(normals)
    return {
        "method": "complete-cloth-head-cross-section-fit",
        "moved_vertices": moved,
        "changed_faces": [face.index for face in cloth_faces],
        "cloth_vertices": len(cloth_vertices),
        "protected_vertices": len(mesh.vertices) - len(cloth_vertices),
        "maximum_displacement": maximum,
        "anchor": list(anchor),
    }
