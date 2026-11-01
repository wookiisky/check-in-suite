"""用真实源头部验证七个补充来源的脸、眼、嘴与可替换发型分离。"""
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('kenney_heads', ROOT / 'scripts/kenney-character-heads.py')
HEADS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEADS)


# 明确的来源语义必须能在实际源模型上分离，光头不能生成整头发型。
def verify_sources():
    configuration = json.loads((ROOT / 'scripts/kenney-character-sources.json').read_text())
    records = []
    for source in configuration['sources']:
        if source['pack_key'] not in {'graveyard-kit', 'space-kit'}:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        path = ROOT / '.local/3d-sources/provider-packs/kenney' / source['pack_key'] / 'extracted' / source['source_relative_path']
        bpy.ops.import_scene.gltf(filepath=str(path))
        parts = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        reviewed = json.loads((ROOT / 'scripts/kenney-extra-heads.json').read_text())['heads']
        annotation = next(item for item in reviewed if item['key'] == source['key'])
        assert hashlib.sha256(path.read_bytes()).hexdigest() == annotation['source_sha256']
        original = parts['head']
        count = len(original.data.polygons)
        fixed, hair, evidence = HEADS.prepare_head_parts(bpy, bmesh, parts, {'key': source['key'], 'head_nodes': ['head']})
        identity = {index for start, end in annotation['fixed_identity_polygon_ranges'] for index in range(start, end)}
        def signature(obj, polygon):
            return (polygon.material_index, tuple(sorted(tuple(round(value, 5) for value in obj.data.vertices[index].co) for index in polygon.vertices)))
        expected_identity = Counter(signature(original, polygon) for polygon in original.data.polygons if polygon.index in identity)
        actual_identity = Counter(signature(obj, polygon) for obj in fixed for polygon in obj.data.polygons)
        assert all(actual_identity[face] >= count for face, count in expected_identity.items()), source['key']
        assert evidence['method'] == 'reviewed-source-triangle-groups'
        assert len(original.data.polygons) == count
        assert sum(len(obj.data.polygons) for obj in fixed) > 0
        assert sum(len(obj.data.polygons) for obj in hair) < count
        if source['key'].endswith('-skeleton'):
            assert not hair
        else:
            assert hair
        if annotation.get('fixed_fill_uv'):
            target_uv = annotation['fixed_fill_uv']
            filled = sum(1 for obj in fixed for polygon in obj.data.polygons if all(abs(obj.data.uv_layers.active.data[index].uv[axis] - target_uv[axis]) < 1e-5 for index in polygon.loop_indices for axis in [0, 1]))
            expected_fill = sum(end - start for start, end in annotation['fixed_fill_polygon_ranges'])
            assert filled >= expected_fill, (source['key'], filled, expected_fill)
        if source['key'] == 'kenney-space-kit-alien':
            from mathutils import Vector
            from mathutils.bvhtree import BVHTree
            points, polygons = [], []
            for obj in fixed:
                offset = len(points)
                points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
                polygons.extend(tuple(offset + index for index in polygon.vertices) for polygon in obj.data.polygons)
            surface = BVHTree.FromPolygons(points, polygons)
            bounds = annotation['head_landmark_bounds_blender']
            center = Vector(((bounds[0][0] + bounds[0][1]) / 2, (bounds[1][0] + bounds[1][1]) / 2, bounds[2][1] + 1))
            hit = surface.ray_cast(center, Vector((0, 0, -1)))[0]
            assert hit is not None and abs(hit.z - bounds[2][1]) < 1e-5, 'alien antenna removal also removed the cranial top'
        assert evidence['scalp_envelope_verified'] is False
        output = ROOT / '.local/kenney-characters/separated-heads'
        output.mkdir(parents=True, exist_ok=True)
        for label, objects in [('fixed', fixed), ('hair', hair)]:
            if not objects:
                continue
            bpy.ops.object.select_all(action='DESELECT')
            for obj in objects:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = objects[0]
            bpy.ops.export_scene.gltf(filepath=str(output / (source['key'] + '-' + label + '.glb')), export_format='GLB', use_selection=True, export_animations=False)
        records.append({'key': source['key'], 'fixed_faces': sum(len(obj.data.polygons) for obj in fixed), 'hair_faces': sum(len(obj.data.polygons) for obj in hair), 'source_faces': count})
    print(json.dumps(records, ensure_ascii=False))


verify_sources()
