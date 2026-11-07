"""沿标准骨架的后领局部增加衣物余量，保留源面拓扑、开口与蒙皮。"""
from typing import TypedDict


class BackNeckSettings(TypedDict):
    """外化的后领适配范围，以来源骨架的世界单位计量。"""

    anchor_bone: str  # 尾端作为领口中心的躯干骨。
    radius_x: float  # 左右渐变到零的半径。
    radius_z: float  # 上下渐变到零的半径。
    posterior_start: float  # 沿后向轴的影响起点；可递增向后或递减向前。
    posterior_full: float  # 沿同一轴达到完整强度的端点。
    offset: float  # 有符号位移：正值向后，负值向前。


# 同一入口用于来源披肩及已经导出的独立披肩节点，位置以真实胸骨和双肩为准。
def fit_back_neck(obj, rig, settings: BackNeckSettings) -> dict[str, object]:
    bone = rig.data.bones[settings['anchor_bone']]
    anchor = rig.matrix_world @ bone.tail_local
    vertical = ((rig.matrix_world @ bone.tail_local) - (rig.matrix_world @ bone.head_local)).normalized()
    lateral = ((rig.matrix_world @ rig.data.bones['upperarm.l'].head_local) -
               (rig.matrix_world @ rig.data.bones['upperarm.r'].head_local)).normalized()
    posterior = vertical.cross(lateral).normalized()
    lateral = posterior.cross(vertical).normalized()
    inverse = obj.matrix_world.inverted()
    mesh = obj.data
    normals = [normal.vector.copy() for normal in mesh.corner_normals]
    moved, maximum = [], 0.0
    for vertex in mesh.vertices:
        before = obj.matrix_world @ vertex.co
        relative = before-anchor
        x = abs(relative.dot(lateral))/settings['radius_x']
        z = abs(relative.dot(vertical))/settings['radius_z']
        if x >= 1 or z >= 1:
            continue
        y = (relative.dot(posterior)-settings['posterior_start'])/(settings['posterior_full']-settings['posterior_start'])
        y = max(0.0,min(1.0,y))
        # 端点方向决定前/后影响范围；紧支撑渐变保留范围外来源形状与原开口。
        amount = settings['offset']*(1-x*x)**2*(1-z*z)**2*y*y*(3-2*y)
        if abs(amount) <= .0000001:
            continue
        vertex.co = inverse @ (before+posterior*amount)
        moved.append(vertex.index)
        maximum = max(maximum,abs(amount))
    mesh.update()
    moved_set = set(moved)
    changed_faces = []
    for face in mesh.polygons:
        if not moved_set.intersection(face.vertices):
            continue
        changed_faces.append(face.index)
        for loop in face.loop_indices:
            normals[loop] = mesh.vertices[mesh.loops[loop].vertex_index].normal.copy() if face.use_smooth else face.normal.copy()
    if changed_faces:
        mesh.normals_split_custom_set(normals)
    return {'method':'bone-relative-posterior-neck-clearance','moved_vertices':moved,
            'changed_faces':changed_faces,'maximum_displacement':maximum,
            'anchor':list(anchor),'posterior':list(posterior)}
