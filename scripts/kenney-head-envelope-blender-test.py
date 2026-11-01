"""用真实原型方头证明头壳沿标准表面弯曲，绑定权重与身体保持原样。"""
import importlib.util
import json
from pathlib import Path

import bmesh
import bpy
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 方头只有范围相同仍会穿发；真实表面和足够细分共同决定兼容形状。
def verify_prototype_envelope():
    modules = {}
    for name, filename in [('heads', 'kenney-character-heads.py'), ('binding', 'provider-character-binding.py')]:
        spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
        modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(modules[name])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin/character-medium-v1.glb'))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    points = [vertex.co.copy() for name in ['body_head', 'body_scalp'] for vertex in canonical[name].data.vertices]
    bounds = [[min(point[axis] for point in points), max(point[axis] for point in points)] for axis in range(3)]
    surfaces = [BVHTree.FromPolygons([vertex.co.copy() for vertex in canonical[name].data.vertices], [tuple(face.vertices) for face in canonical[name].data.polygons]) for name in ['body_head', 'body_scalp']]
    configuration = json.loads((ROOT / 'scripts/kenney-character-sources.json').read_text())
    source = next(source for source in configuration['sources'] if source['key'] == 'kenney-prototype-kit-figurine')
    source = {**configuration['profiles'][source['profile']], **source}
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / '.local/3d-sources/provider-packs/kenney/prototype-kit/extracted' / source['source_relative_path']))
    parts, source, _ = modules['binding'].bind_parts(bpy, bmesh, rig, set(bpy.data.objects) - before, source, canonical)
    head = parts[source['head_nodes'][0]]
    torso_before = [vertex.co.copy() for vertex in parts[source['body_nodes'][0]].data.vertices]
    count = len(head.data.polygons)
    envelope_points = [vertex.co.copy() for vertex in canonical['body_scalp'].data.vertices]
    low = min(point.z for point in envelope_points)
    high = max(point.z for point in envelope_points)
    for point in envelope_points:
        point.z = bounds[2][0] + (point.z-low)/(high-low)*(bounds[2][1]-bounds[2][0])
    modules['heads'].fit_head_envelope(bmesh, [head], [], bounds, envelope_points)
    envelope = bmesh.new()
    for point in envelope_points:
        envelope.verts.new(point)
    bmesh.ops.convex_hull(envelope, input=list(envelope.verts), use_existing_faces=False)
    reference = BVHTree.FromBMesh(envelope)
    envelope.free()
    assert len(head.data.polygons) > count
    assert max(reference.find_nearest(vertex.co)[3] for vertex in head.data.vertices) < 1e-4
    assert all(abs(sum(group.weight for group in vertex.groups) - 1) < 1e-5 for vertex in head.data.vertices)
    assert torso_before == [vertex.co for vertex in parts[source['body_nodes'][0]].data.vertices]
    print('真实原型头壳表面拟合与权重检查通过')


verify_prototype_envelope()
