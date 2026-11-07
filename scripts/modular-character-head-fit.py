"""离线补基础身体的颈部支撑，头脸与头饰仍保持原有几何和穿戴身份。"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from bpy.types import Object


class NeckSupport(TypedDict):
    """标准骨架空间的颈部截面，不属于任何脸型或衣物。"""

    sections: list[list[float]]  # 高度、左右半径、前后半径及 head 骨权重。
    segments: int  # 每圈顶点数，配合已有低面数身体。


# 只向躯干添加闭合颈段，既有顶点、骨架、脸型和衣物均不移动。
def add_body_neck_support(torso: Object, rig: Object, settings: NeckSupport) -> dict:
    import bpy
    from mathutils import Vector

    sections = settings['sections']
    segments = settings['segments']
    inverse = torso.matrix_world.inverted()
    vertices = [inverse @ Vector((rx * math.cos(index * math.tau / segments),
                                 ry * math.sin(index * math.tau / segments), z))
                for z, rx, ry, _ in sections for index in range(segments)]
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(sections) - 1):
        for index in range(segments):
            following = (index + 1) % segments
            faces.append((row * segments + index, row * segments + following,
                          (row + 1) * segments + following, (row + 1) * segments + index))
    faces.append(tuple((len(sections) - 1) * segments + index for index in range(segments)))

    # 复用本身体颈顶的材质及色块；骷髅不会被改成统一肤色。
    top_vertex = max(torso.data.vertices, key=lambda vertex: (torso.matrix_world @ vertex.co).z)
    source_face = next(face for face in torso.data.polygons if top_vertex.index in face.vertices)
    material = torso.data.materials[source_face.material_index]
    mesh = bpy.data.meshes.new('_body_neck_support_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    if torso.data.uv_layers.active:
        source_uv = torso.data.uv_layers.active.data
        uv = sum((source_uv[index].uv for index in source_face.loop_indices), Vector((0, 0))) / len(source_face.loop_indices)
        layer = mesh.uv_layers.new(name=torso.data.uv_layers.active.name)
        for loop in layer.data:
            loop.uv = uv
    for face in mesh.polygons:
        face.use_smooth = len(face.vertices) == 4

    support = bpy.data.objects.new('_body_neck_support', mesh)
    bpy.context.collection.objects.link(support)
    support.parent = rig
    support.matrix_world = torso.matrix_world.copy()
    chest = support.vertex_groups.new(name='chest')
    head = support.vertex_groups.new(name='head')
    for row, (_, _, _, weight) in enumerate(sections):
        indices = list(range(row * segments, (row + 1) * segments))
        if weight < 1:
            chest.add(indices, 1 - weight, 'REPLACE')
        if weight > 0:
            head.add(indices, weight, 'REPLACE')
    before_vertices, before_faces = len(torso.data.vertices), len(torso.data.polygons)
    bpy.ops.object.select_all(action='DESELECT')
    torso.select_set(True)
    support.select_set(True)
    bpy.context.view_layer.objects.active = torso
    bpy.ops.object.join()
    return {'method': 'body-neck-support', 'sections': sections, 'segments': segments,
            'added_vertices': len(torso.data.vertices) - before_vertices,
            'added_faces': len(torso.data.polygons) - before_faces,
            'material': material.name, 'belongs_to': 'body_torso'}
