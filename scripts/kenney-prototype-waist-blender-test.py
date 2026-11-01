"""使用四个真实原型源验证躯干与腿的接触高度随标准化共同保留。"""
import importlib.util
import json
from pathlib import Path

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('prototype_binding', ROOT / 'scripts/provider-character-binding.py')
BINDING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BINDING)


# 标准化可改变整体比例，但不能把原本衔接的躯干轮廓抬到腿顶上方。
def verify_source_contact():
    configuration = json.loads((ROOT / 'scripts/kenney-character-sources.json').read_text())
    for source in configuration['sources']:
        if source['profile'] != 'prototype-six-parts':
            continue
        specification = {**configuration['profiles'][source['profile']], **source}
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin/character-medium-v1.glb'))
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        expected_top = max(vertex.co.z for vertex in canonical['body_legs'].data.vertices)
        before = set(bpy.data.objects)
        path = ROOT / '.local/3d-sources/provider-packs/kenney/prototype-kit/extracted' / source['source_relative_path']
        bpy.ops.import_scene.gltf(filepath=str(path))
        imported = set(bpy.data.objects) - before
        objects = {obj.name: obj for obj in imported if obj.type == 'MESH'}
        original_torso = objects['torso']
        source_top = max((objects[name].matrix_world @ vertex.co).z for name in ['leg-left', 'leg-right'] for vertex in objects[name].data.vertices)
        contacts = [vertex.index for vertex in original_torso.data.vertices if abs((original_torso.matrix_world @ vertex.co).z - source_top) < 1e-5]
        assert contacts, source['key'] + ': source torso has no leg-height contour'
        parts, updated, evidence = BINDING.bind_parts(bpy, bmesh, rig, imported, specification, canonical)
        torso = parts[updated['body_nodes'][0]]
        actual = [torso.data.vertices[index].co.z for index in contacts]
        assert max(abs(value - expected_top) for value in actual) < 1e-5, (source['key'], actual, expected_top)
        assert abs(min(vertex.co.z for vertex in torso.data.vertices) - .60) < 1e-5
        assert abs(max(vertex.co.z for vertex in torso.data.vertices) - 1.32) < 1e-5
        for vertex in torso.data.vertices:
            assert abs(sum(group.weight for group in vertex.groups) - 1) < 1e-5
        assert evidence['torso_waist_fit']['source_height'] == source_top
        print('原型躯干与腿顶接触高度检查通过', source['key'], source_top, expected_top, len(contacts))


verify_source_contact()
