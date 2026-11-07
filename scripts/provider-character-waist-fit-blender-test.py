"""用真实原包验证旧腰带只按实际腰部留松量，不接受上装胸腹包络外扩。"""
import copy
import importlib.util
import json
import argparse
import hashlib
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 测试直接调用实际原包标准化入口，不复制其拟合逻辑。
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 腰带与腰包各自保持完整连通件，尺寸只取环绕身体的主环。
def main_ring(obj, normalizer, producer):
    slots = normalizer.native_torso_face_slots(obj, .75, .81)
    components = []
    for faces in producer.connected_faces(obj):
        if not faces or not faces.issubset(slots['lower']):
            continue
        indices = {i for face in obj.data.polygons if face.index in faces for i in face.vertices}
        points = [obj.data.vertices[i].co for i in indices]
        box = [[min(point[axis] for point in points), max(point[axis] for point in points)] for axis in range(3)]
        components.append((faces, box))
    return max(components, key=lambda row: (row[1][0][1]-row[1][0][0])*(row[1][1][1]-row[1][1][0]))


# 记录实际面、UV及权重，防止修尺寸时丢失扣具、口袋或蒙皮。
def identity(obj):
    return {'faces': [tuple(face.vertices) for face in obj.data.polygons],
            'uv': [tuple(loop.uv) for loop in obj.data.uv_layers.active.data],
            'weights': [[(obj.vertex_groups[group.group].name, round(group.weight, 6)) for group in vertex.groups]
                        for vertex in obj.data.vertices],
            'materials': [material.name.split('.')[0] for material in obj.data.materials]}


# 相同原包与规范身体分别关闭/开启适配，独立观察实际产物。
def normalize(source, canonical, binding, enabled):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT/canonical))
    canonical_parts = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT/source['source']))
    spec = copy.deepcopy(source['spec'])
    if not enabled:
        spec.pop('torso_clothing_fit', None)
    parts, updated, evidence = binding.bind_parts(bpy, bmesh, rig, set(bpy.data.objects)-before, spec, canonical_parts)
    return parts[updated['body_nodes'][0]], canonical_parts, evidence


# 主环不能被整段胸腹凸包推到实际腰部之外；本来的源松量继续保留。
def verify_source(source, recipe, binding, normalizer, producer):
    original, _, _ = normalize(source, recipe['canonical_input']['path'], binding, False)
    before_identity = identity(original)
    source_faces, source_box = main_ring(original, normalizer, producer)
    source_tree = BVHTree.FromPolygons([vertex.co.copy() for vertex in original.data.vertices],
                                     [tuple(face.vertices) for face in original.data.polygons if face.index in source_faces])
    lower_faces = normalizer.native_torso_face_slots(original, .75, .81)['lower']
    lower_vertices = {index for face in original.data.polygons if face.index in lower_faces for index in face.vertices}
    expected_z = [vertex.co.z for vertex in original.data.vertices]
    actual, bodies, evidence = normalize(source, recipe['canonical_input']['path'], binding, True)
    actual_faces, actual_box = main_ring(actual, normalizer, producer)
    actual_tree = BVHTree.FromPolygons([vertex.co.copy() for vertex in actual.data.vertices],
                                     [tuple(face.vertices) for face in actual.data.polygons if face.index in actual_faces])
    fit = source['spec']['torso_clothing_fit']
    clearance = fit.get('waist_clearance', fit['clearance'])
    report = evidence['torso_clothing_fit']
    assert report['clearance'] == fit['clearance'], 'lower clearance changed upper declaration'
    assert report['waist_clothing_fit'], 'waist fit evidence missing'
    assert all(row['clearance'] == clearance for row in report['waist_clothing_fit']), 'lower clearance ignored'
    reference = source['spec']['torso_clothing_fit'].get('waist_reference')
    if reference:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT/reference['path']))
        added = set(bpy.data.objects)-before
        bodies = {obj.name.split('.')[0]:obj for obj in added if obj.type == 'MESH'}
    points, faces = [], []
    for key in ['body_torso', 'body_legs']:
        obj = bodies[key]
        offset = len(points)
        points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        faces.extend(tuple(index+offset for index in face.vertices) for face in obj.data.polygons)
    if reference:
        for obj in added:
            bpy.data.objects.remove(obj,do_unlink=True)
    envelope = BVHTree.FromPolygons(points, faces)
    for axis in range(2):
        checked = 0
        for sample in [.2, .5, .8]:
            z = source_box[2][0]+sample*(source_box[2][1]-source_box[2][0])
            for sign in [-1, 1]:
                direction = Vector(tuple(sign if i == axis else 0 for i in range(3)))
                origin = Vector((0,0,z))
                body_hit = envelope.ray_cast(direction*3+origin, -direction, 6)[0]
                original_hit = source_tree.ray_cast(origin,direction,3)[0]
                actual_hit = actual_tree.ray_cast(origin,direction,3)[0]
                if any(hit is None for hit in [body_hit,original_hit,actual_hit]):
                    continue
                checked += 1
                # 比较内口而非外壁，源腰带自身厚度不能被误当作悬空间隙。
                maximum = max(abs(original_hit[axis]), abs(body_hit[axis]) + clearance) + .006
                observed = abs(actual_hit[axis])
                assert observed <= maximum, f'{source["key"]}: lower axis {axis} expanded by torso envelope: {observed:.6f} > {maximum:.6f}'
        assert checked >= 2, source['key'] + ': too few measured waist sections'
    assert identity(actual) == before_identity, source['key'] + ': faces/UV/weights/materials changed'
    assert max(abs(a-b.co.z) for a,b in zip(expected_z,actual.data.vertices)) < .000001, source['key'] + ': garment height changed'
    protected = {vertex.index: vertex.co.copy() for vertex in actual.data.vertices if vertex.index not in lower_vertices}
    # 不传lower声明复现既有upper算法；新腰带路径不能连带改变这些受保护顶点。
    legacy = copy.deepcopy(source)
    legacy['spec'].pop('native_waist_accessory_top', None)
    previous, _, _ = normalize(legacy, recipe['canonical_input']['path'], binding, True)
    assert identity(previous) == before_identity, source['key'] + ': old upper path attribute mismatch'
    maximum = max(((previous.data.vertices[index].co-point).length for index,point in protected.items()),default=0)
    assert maximum < .000001, f'{source["key"]}: lower fit changed protected upper/body geometry by {maximum:.6f}'


binding = load('waist_fit_binding', 'provider-character-binding.py')
normalizer = load('waist_fit_normalizer', 'import-provider-characters.py')
producer = load('waist_fit_producer', 'prepare-modular-characters.py')
recipe = json.loads((ROOT/'scripts/modular-character-sources.json').read_text())
sources = [source for source in recipe['sources'] if source['key'].startswith('kaykit-legacy-skeleton-')]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--waist-reference',type=Path)
parser.add_argument('--waist-clearance',type=float)
arguments = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if arguments.waist_reference:
    path = arguments.waist_reference.resolve()
    reference = {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    for source in sources:
        source['spec']['torso_clothing_fit']['waist_reference'] = reference
if arguments.waist_clearance is not None:
    for source in sources:
        source['spec']['torso_clothing_fit']['waist_clearance'] = arguments.waist_clearance
assert len(sources) == 4
for source in sources:
    verify_source(source, recipe, binding, normalizer, producer)
    print('旧腰带局部适配通过', source['key'])

if arguments.waist_reference:
    invalid = copy.deepcopy(sources[0])
    invalid['spec']['torso_clothing_fit']['waist_reference']['sha256'] = '0' * 64
    try:
        normalize(invalid, recipe['canonical_input']['path'], binding, True)
    except ValueError as error:
        assert 'waist body reference checksum mismatch' in str(error), str(error)
    else:
        raise AssertionError('changed waist reference accepted with stale checksum')
    print('裸腰参考哈希变更拒绝通过')
