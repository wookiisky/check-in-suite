"""把被旧腰线切开的法师腰饰完整移到下装，并整理两侧的新衣边。"""

from collections import defaultdict
from typing import TypedDict


class MageWaist(TypedDict):
    """在标准骨架绑定姿势下核对过的切面和目标腰口高度。"""

    source_cut: float  # 在原腰部配饰和最下方衣扣的上缘之外。
    upper_hem: float  # 上装的下缘高度。
    lower_rim: float  # 下装的上缘高度，留出与上装的搭接量。


# glTF会为不同UV复制同位置的点，渐变时把这些衣片边缘视作相连。
def linked_vertices(mesh, starts):
    coincident = defaultdict(list)
    for vert in mesh.verts:
        coincident[tuple(round(value, 5) for value in vert.co)].append(vert)
    selected = set()
    pending = list(starts)
    while pending:
        vert = pending.pop()
        if vert in selected:
            continue
        selected.add(vert)
        pending.extend(coincident[tuple(round(value, 5) for value in vert.co)])
        pending.extend(edge.other_vert(vert) for edge in vert.link_edges)
    return selected


# 用同一高度重新切分两件衣服；下装先接回旧腰线上的全部原面。
def split_mage_waist(upper, lower, settings: MageWaist, original_seam, seam_weights):
    import bmesh
    from mathutils import Vector

    source_cut = settings['source_cut']
    lower_mesh = bmesh.new()
    lower_mesh.from_mesh(upper.data)
    lower_mesh.from_mesh(lower.data)
    old_boundary = [vert for vert in lower_mesh.verts if abs(vert.co.z - original_seam) < 1e-5]
    bmesh.ops.remove_doubles(lower_mesh, verts=old_boundary, dist=1e-5)
    upper_mesh = bmesh.new()
    upper_mesh.from_mesh(upper.data)

    def cut(mesh, obj, is_lower, target):
        geometry = list(mesh.verts) + list(mesh.edges) + list(mesh.faces)
        bmesh.ops.bisect_plane(mesh, geom=geometry, dist=1e-6,
                              plane_co=Vector((0, 0, source_cut)), plane_no=Vector((0, 0, 1)),
                              clear_inner=not is_lower, clear_outer=is_lower)
        loose = [vert for vert in mesh.verts if not vert.link_faces]
        bmesh.ops.delete(mesh, geom=loose, context='VERTS')
        at_cut = [vert for vert in mesh.verts if abs(vert.co.z - source_cut) < 1e-5]
        bmesh.ops.remove_doubles(mesh, verts=at_cut, dist=1e-5)
        edge = [item for item in mesh.edges if item.is_boundary
                and all(abs(vert.co.z - source_cut) < 1e-5 for vert in item.verts)]

        # 腰带和挂件沿高度整体下移，从衣摆下缘才逐渐恢复原高。袖口和裤腿留在原位。
        deform = mesh.verts.layers.deform.active
        bones = {obj.vertex_groups[name].index: weight for name, weight in seam_weights.items()}
        starts = [vert for vert in mesh.verts if vert.co.z > 0.54] if is_lower else at_cut
        for vert in linked_vertices(mesh, (vert for vert in starts if vert.is_valid)):
            height = vert.co.z
            if is_lower:
                influence = min(1, max(0, (height - 0.36) / 0.20))
            else:
                influence = max(0, 1 - (height - source_cut) / 0.13)
            vert.co.z += (target - source_cut) * influence
            seam = max(0, 1 - abs(height - source_cut) / 0.045)
            if seam:
                weights = vert[deform]
                blended = [(bone, weights.get(bone, 0) * (1 - seam) + bones.get(bone, 0) * seam)
                           for bone in set(weights.keys()) | bones.keys()]
                strongest = sorted(blended, key=lambda item: (-item[1], item[0]))[:4]
                total = sum(weight for _, weight in strongest if weight > 1e-6)
                weights.clear()
                for bone, weight in strongest:
                    if weight > 1e-6:
                        weights[bone] = weight / total
                if is_lower:
                    vert.co.x *= 1 + 0.06 * seam
                    vert.co.y *= 1 + 0.06 * seam

        # 沿切口往内折出薄边。独立穿着也有清楚的衣口，内部留给身体穿过。
        by_edge = {item: item.link_faces[0] for item in edge}
        uv = mesh.loops.layers.uv.active
        fold = bmesh.ops.extrude_edge_only(mesh, edges=edge)['geom']
        inner = {vert for vert in fold if isinstance(vert, bmesh.types.BMVert)}
        for face in (item for item in fold if isinstance(item, bmesh.types.BMFace)):
            shared = next(item for item in face.edges if item in by_edge)
            original = by_edge[shared]
            face.material_index = original.material_index
            face.smooth = original.smooth
            for loop in face.loops:
                closest = min(shared.verts, key=lambda vert: (vert.co - loop.vert.co).length_squared)
                loop[uv].uv = next(old[uv].uv for old in original.loops if old.vert == closest)
        for vert in inner:
            vert.co.x *= 0.96
            vert.co.y *= 0.96
            vert.co.z += -0.008 if is_lower else 0.008
        mesh.normal_update()
        mesh.to_mesh(obj.data)
        mesh.free()
        return len(edge)

    upper_edges = cut(upper_mesh, upper, False, settings['upper_hem'])
    lower_edges = cut(lower_mesh, lower, True, settings['lower_rim'])
    return {'source_cut': source_cut, 'upper_edges': upper_edges, 'lower_edges': lower_edges}
