"""调整头盔的面部开口，保留独立的角与护颊。"""
from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from collections.abc import Callable
    from bpy.types import Object


class HelmetOpening(TypedDict):
    """绑定姿势中前沿的抬升范围。"""

    front_band: list[float]  # 从完全抬升到不抬升的前后坐标。
    height_band: list[float]  # 从完全抬升到不抬升的高度。
    front_lift: float  # 鼻护尖端的最大抬升量。


# 盔顶和金属前沿属于最大的连通件，角和护颊仍使用原始网格。
def fit_helmet_opening(
    obj: Object, settings: HelmetOpening, connected_faces: Callable[[Object], list[set[int]]],
) -> int:
    from mathutils import Matrix, Vector

    front, back = settings['front_band']
    bottom, top = settings['height_band']
    lift = settings['front_lift']
    shell = max(connected_faces(obj), key=len)
    indices = {index for polygon in shell for index in obj.data.polygons[polygon].vertices}
    world = obj.matrix_world
    inverse = world.inverted()
    world_axes, local_axes = world.to_3x3(), inverse.to_3x3()
    normals = [normal.vector.copy() for normal in obj.data.corner_normals]
    corrections = {}
    for index in indices:
        vertex = obj.data.vertices[index]
        point = world @ vertex.co
        depth = (back - point.y) / (back - front)
        height = (top - point.z) / (top - bottom)
        if depth <= 0 or height <= 0:
            continue
        depth_weight = min(depth, 1)
        height_weight = min(height, 1)
        vertex.co = inverse @ (point + Vector((0, 0, lift * depth_weight * height_weight)))

        # 用变形的局部导数同步更新角法线，保持原有的金属边与盔面明暗。
        depth_slope = -lift * height_weight / (back - front) if depth < 1 else 0
        height_slope = 1 - lift * depth_weight / (top - bottom) if height < 1 else 1
        jacobian = Matrix(((1, 0, 0), (0, 1, 0), (0, depth_slope, height_slope)))
        corrections[index] = (local_axes @ jacobian @ world_axes).inverted().transposed()

    obj.data.update()
    for loop in obj.data.loops:
        if correction := corrections.get(loop.vertex_index):
            normals[loop.index] = (correction @ normals[loop.index]).normalized()
    obj.data.normals_split_custom_set(normals)
    return len(corrections)
