"""在绑定姿势下局部调整衣摆和腰口，保留衣物的拓扑与材质。"""

from bisect import bisect_right
from typing import NotRequired, TypedDict


class WaistSeam(TypedDict):
    sections: list[list[float]]  # 原高度、目标高度、水平比例。
    skin_band: NotRequired[list[float]]  # 过渡到公共腰口蒙皮的目标高度范围。
    main_component: NotRequired[bool]  # 有独立裤腿时只调整腰带所在的主体。


# 同一水平截面用相同变换，腰带、扣具与衣片的相对位置一起保留。
def fit_waist_seam(obj, vertices, settings: WaistSeam, seam_height, seam_weights):
    from mathutils import Matrix, Vector

    sections = settings['sections']
    heights = [source for source, _, _ in sections]
    world = obj.matrix_world
    inverse = world.inverted()
    world_axes, local_axes = world.to_3x3(), inverse.to_3x3()
    normals = [normal.vector.copy() for normal in obj.data.corner_normals]
    corrections = {}
    skin_band = settings.get('skin_band')
    for index in vertices:
        vertex = obj.data.vertices[index]
        point = world @ vertex.co
        segment = bisect_right(heights, point.z)
        if 0 < segment < len(sections):
            low, high = sections[segment - 1], sections[segment]
            span = high[0] - low[0]
            t = (point.z - low[0]) / span
            height = low[1] + (high[1] - low[1]) * t
            scale = low[2] + (high[2] - low[2]) * t
            slope = (high[1] - low[1]) / span
            taper = (high[2] - low[2]) / span
        else:
            source, target, scale = sections[0 if segment == 0 else -1]
            height, slope, taper = point.z + target - source, 1, 0
        if scale != 1 or abs(height - point.z) > 1e-7:
            vertex.co = inverse @ Vector((point.x * scale, point.y * scale, height))
        if scale != 1 or taper or slope != 1:
            jacobian = Matrix(((scale, 0, point.x * taper), (0, scale, point.y * taper), (0, 0, slope)))
            corrections[index] = (local_axes @ jacobian @ world_axes).inverted().transposed()

        # 腰口跟随标准上衣。离开接合区域后逐步恢复衣物原有蒙皮。
        if not skin_band:
            continue
        first, last = skin_band
        extent = seam_height - first if height <= seam_height else last - seam_height
        mix = max(0, 1 - abs(height - seam_height) / extent)
        if mix:
            original = {obj.vertex_groups[group.group].name: group.weight for group in vertex.groups}
            for name in original.keys() | seam_weights.keys():
                group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                weight = original.get(name, 0) * (1 - mix) + seam_weights.get(name, 0) * mix
                if weight > 1e-6:
                    group.add([vertex.index], weight, 'REPLACE')
                elif name in original:
                    group.remove([vertex.index])

    obj.data.update()
    for loop in obj.data.loops:
        if correction := corrections.get(loop.vertex_index):
            normals[loop.index] = (correction @ normals[loop.index]).normalized()
    obj.data.normals_split_custom_set(normals)
