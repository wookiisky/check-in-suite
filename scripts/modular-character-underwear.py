"""从实际裸身表面裁出贴身的默认背心和内裤，沿用对应部位的蒙皮。"""

import bmesh
import bpy
from mathutils import Matrix


# 缝合躯干与四肢分区后沿外法线留布料间隙，保留源骨骼权重。
def body_surface(sources, clearance, seam=None):
    mesh = bmesh.new()
    skin = mesh.verts.layers.deform.verify()
    names = list(dict.fromkeys(group.name for source in sources for group in source.vertex_groups))
    groups = {name: index for index, name in enumerate(names)}
    for source in sources:
        vertices = []
        for point in source.data.vertices:
            vertex = mesh.verts.new(source.matrix_world @ point.co)
            for weight in point.groups:
                vertex[skin][groups[source.vertex_groups[weight.group].name]] = weight.weight
            vertices.append(vertex)
        for face in source.data.polygons:
            points = [vertices[index] for index in face.vertices]
            if seam is not None and all(abs(vertex.co.z - seam) < 1e-5 for vertex in points):
                continue  # 裸髋的内封盖在穿着后仍应处于衣物内部。
            mesh.faces.new(points)
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=1e-5)
    mesh.normal_update()
    for vertex in mesh.verts:
        vertex.co += clearance * vertex.normal
    return mesh, names


# 保留切面朝法线的一侧。切出的新顶点沿原网格插值蒙皮。
def trim(mesh, point, normal):
    bmesh.ops.bisect_plane(
        mesh, geom=[*mesh.verts, *mesh.edges, *mesh.faces],
        plane_co=point, plane_no=normal, dist=1e-6, clear_inner=True,
    )


# 左右各自裁出领口或裤脚，再在正中焊接，避免画面出现缝隙。
def garment(name, rig, sources, settings, seam=None):
    mesh, groups = body_surface(sources, settings['clearance'], seam)
    points, faces, weights, indices = [], [], [], {}
    for side in [-1, 1]:
        half = mesh.copy()
        trim(half, (0, 0, 0), (side, 0, 0))
        for height, x_slope, z_direction in settings['cuts']:
            trim(half, (0, 0, height), (side * x_slope, 0, z_direction))
        skin = half.verts.layers.deform.active
        for face in half.faces:
            corners = []
            for vertex in face.verts:
                key = tuple(round(value, 6) for value in vertex.co)
                if key not in indices:
                    indices[key] = len(points)
                    points.append(vertex.co.copy())
                    weights.append(dict(vertex[skin]))
                corners.append(indices[key])
            faces.append(corners)
        half.free()
    mesh.free()

    data = bpy.data.meshes.new(name + '_mesh')
    data.from_pydata(points, [], faces)
    data.update()
    cloth = bpy.data.materials.new(name)
    cloth.use_nodes = True
    cloth.diffuse_color = settings['color']
    shader = cloth.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = settings['color']
    shader.inputs['Roughness'].default_value = 0.86
    data.materials.append(cloth)
    for face in data.polygons:
        face.use_smooth = True
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = Matrix.Identity(4)
    for group in groups:
        obj.vertex_groups.new(name=group)
    for index, skinning in enumerate(weights):
        total = sum(skinning.values())
        for group, weight in skinning.items():
            obj.vertex_groups[group].add([index], weight / total, 'REPLACE')
    lining = obj.modifiers.new('ClothEdge', 'SOLIDIFY')
    lining.thickness = 0.004
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=lining.name)
    obj.modifiers.new('CharacterRig', 'ARMATURE').object = rig
    return obj
