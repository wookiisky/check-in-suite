"""用实际巡林客来源和 GLB 导入、导出校验圆头形象。"""
from collections import Counter
import importlib.util
import json
from pathlib import Path
import tempfile

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    """加载与人物制作流程共用的模块。"""
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def select(source, name, include):
    """复制实际来源中指定的头饰面及材质。"""
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = name
    bpy.context.collection.objects.link(obj)
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.faces.index_update()
    bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if face.index not in include], context='FACES')
    bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
    mesh.to_mesh(obj.data)
    mesh.free()
    return obj


def bind(obj, bone):
    """像正式制作者一样，把静态形象挂到规范头骨。"""
    world = obj.matrix_world.copy()
    obj.parent = None
    obj.data.transform(world)
    obj.matrix_world = Matrix.Identity(4)
    obj.vertex_groups.clear()
    obj.vertex_groups.new(name=bone).add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    obj.modifiers.clear()
    obj.parent = next(item for item in bpy.data.objects if item.type == 'ARMATURE')
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = Matrix.Identity(4)
    obj.modifiers.new('CharacterRig', 'ARMATURE').object = obj.parent


def surface_edges(obj, faces):
    """在序列化后按空间位置配对真实三角面的边和角法线。"""
    mesh = obj.data
    points = [tuple(round(value, 5) for value in obj.matrix_world @ vertex.co) for vertex in mesh.vertices]
    edges = Counter()
    normals = {}
    for face in faces:
        corners = [mesh.loops[index] for index in face.loop_indices]
        for index, corner in enumerate(corners):
            a = points[corner.vertex_index]
            b = points[corners[(index + 1) % len(corners)].vertex_index]
            edges[tuple(sorted((a, b)))] += 1
            normals[a] = mesh.corner_normals[corner.index].vector.copy()
    return edges, normals


def verify_skin(head, scalp, connected_faces):
    """独立核对脸和头皮共同闭合，接边位置、材质、法线都一致。"""
    shell_indices = max(connected_faces(head), key=len)
    shell = [face for face in head.data.polygons if face.index in shell_indices]
    head_edges, head_normals = surface_edges(head, shell)
    scalp_edges, scalp_normals = surface_edges(scalp, scalp.data.polygons)
    rim = {edge for edge, count in scalp_edges.items() if count == 1}
    assert rim == {edge for edge, count in head_edges.items() if count == 1}, '序列化后出现可见缝隙'
    assert all(count == 2 for count in (head_edges + scalp_edges).values()), '头壳有重叠面或开放边'
    for point in {point for edge in rim for point in edge}:
        assert head_normals[point].dot(scalp_normals[point]) > 0.9999, '接边法线断开'
    assert head.data.materials[shell[0].material_index] == scalp.data.materials[0], '接边肤色使用不同材质'

    tree = BVHTree.FromPolygons([head.matrix_world @ vertex.co for vertex in head.data.vertices],
                                [tuple(face.vertices) for face in shell])
    for x, y in [(0, 0), (-0.065, 0), (0.065, 0), (0, -0.055), (0, 0.055)]:
        point, _, _, _ = tree.ray_cast(Vector((x, y, 1.19)), Vector((0, 0, 1)))
        assert point and 1.24 < point.z < 1.32, '头底离开基础身体颈部支撑'

    # 中央口腔仍比上下唇靠后，确保圆化不会把笑嘴压平。
    mouth = [head.matrix_world @ vertex.co for vertex in head.data.vertices
             if abs(vertex.co.x) < 0.0001 and vertex.co.y < -0.3]
    lips = [min(mouth, key=lambda point: abs(point.z - z)) for z in (1.403, 1.429, 1.445)]
    assert lips[1].y - max(lips[0].y, lips[2].y) > 0.015, '嘴唇与口腔压成平面'


def verify():
    """从配方指定的真实来源加工，导出再导入后检查结果。"""
    prepare = load('prepare', 'prepare-modular-characters.py')
    smile = load('smile', 'modular-character-smile-head.py')
    recipe = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(item for item in recipe['sources'] if item['key'] == 'kaykit-adventurers-ranger')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    head = bpy.data.objects['body_head']
    scalp = bpy.data.objects['body_scalp']
    hair = bpy.data.objects['hair_provider']
    brow_faces = smile.brow_faces(hair, prepare.connected_faces)
    brows = select(hair, 'face_brows', brow_faces)
    headwear = select(hair, 'head_provider', set(range(len(hair.data.polygons))) - brow_faces)
    original_hair = [vertex.co.copy() for vertex in headwear.data.vertices]
    fitted = smile.fit_beard(headwear, head, prepare.connected_faces)
    moved = [index for index, vertex in enumerate(headwear.data.vertices)
             if (vertex.co - original_hair[index]).length > 0.0001]
    assert fitted and moved and all(original_hair[index].z < 1.55 for index in moved)
    head, scalp, evidence = smile.reshape(head, scalp, prepare.connected_faces, bind, brows=brows)
    assert evidence['rim_vertices'] == 28
    assert evidence['preserved_feature_faces'] > 0
    assert evidence['preserved_brow_faces'] == len(brow_faces)
    head.name = 'face_head'
    scalp.name = 'face_scalp'

    with tempfile.TemporaryDirectory() as output:
        path = Path(output) / 'smile.glb'
        bpy.ops.object.select_all(action='DESELECT')
        for obj in (head, scalp, brows, head.parent):
            obj.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
    face_parts = [bpy.data.objects[name] for name in ('face_head', 'face_scalp', 'face_brows')]
    for obj in face_parts:
        assert any(modifier.type == 'ARMATURE' for modifier in obj.modifiers)
        assert all(len(vertex.groups) == 1
                   and obj.vertex_groups[vertex.groups[0].group].name == 'head'
                   and abs(vertex.groups[0].weight - 1) < 0.0001 for vertex in obj.data.vertices)
    verify_skin(*face_parts[:2], prepare.connected_faces)
    assert len(prepare.connected_faces(face_parts[2])) == 2, '眉毛失去独立左右几何'
    print('微笑脸 GLB 圆头、颈部、嘴唇、眉毛和头骨绑定检查通过')


if __name__ == '__main__':
    verify()
