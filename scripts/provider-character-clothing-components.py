"""原生衣物按真实连通件归槽，供标准化拟合和后续提取共用。"""


# 原包已审核的白骨和暗色骨缝属于身体，其余材质保留为原生衣物。
def legacy_body_face(source, face):
    return source.data.materials[face.material_index].name.split('.')[0] in ['White', 'Black']


# UV或材质边界复制的顶点仍按实际位置连接，衣扣不能被腰线裁掉。
def garment_components(source):
    garments = [face for face in source.data.polygons if not legacy_body_face(source, face)]
    positions, face_positions = {}, {}
    for face in garments:
        points = {tuple(round(value, 5) for value in source.data.vertices[index].co) for index in face.vertices}
        face_positions[face.index] = points
        for point in points:
            positions.setdefault(point, set()).add(face.index)
    remaining = {face.index for face in garments}
    result = []
    while remaining:
        pending = [min(remaining)]
        faces, points = set(), set()
        while pending:
            index = pending.pop()
            if index not in remaining:
                continue
            remaining.remove(index)
            faces.add(index)
            points.update(face_positions[index])
            pending.extend(neighbor for point in face_positions[index] for neighbor in positions[point] if neighbor in remaining)
        result.append({'faces': faces, 'points': points})
    return result


# 腰带和衣片整件归槽，不能按腰线切断一件衣物。
def native_torso_face_slots(source, waist, accessory_top):
    slots = {'upper': set(), 'lower': set()}
    for component in garment_components(source):
        low = min(point[2] for point in component['points'])
        high = max(point[2] for point in component['points'])
        slot = 'lower' if low < waist and high <= accessory_top else 'upper'
        slots[slot].update(component['faces'])
    return slots
