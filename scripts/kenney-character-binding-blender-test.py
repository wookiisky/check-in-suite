"""用真实Kenney来源验证标准头部范围、头皮节点映射与正面方向。"""
import importlib.util
import json
from pathlib import Path

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[1]
MODULE = importlib.util.spec_from_file_location('kenney_binding', ROOT / 'scripts/provider-character-binding.py')
BINDING = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(BINDING)
REPRESENTATIVES = ['kenney-prototype-kit-figurine', 'kenney-blocky-characters-a', 'kenney-mini-characters-male-a', 'kenney-space-kit-astronautA', 'kenney-animated-characters-protagonists-criminalmalea']


# 五种结构分别从真实来源拟合，头发不能决定脸型范围。
def verify_representatives():
    configuration = json.loads((ROOT / 'scripts/kenney-character-sources.json').read_text())
    for key in REPRESENTATIVES:
        source = next(item for item in configuration['sources'] if item['key'] == key)
        specification = {**configuration['profiles'][source['profile']], **source}
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin/character-medium-v1.glb'))
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
        points = [vertex.co for name in ['body_head', 'body_scalp'] for vertex in canonical[name].data.vertices]
        expected = [[min(point[axis] for point in points), max(point[axis] for point in points)] for axis in range(3)]
        if specification.get('head_envelope_method') != 'canonical-scalp-envelope':
            scalp = [vertex.co for vertex in canonical['body_scalp'].data.vertices]
            expected[1] = [min(point.y for point in scalp), max(point.y for point in scalp)]
        before = set(bpy.data.objects)
        path = ROOT / '.local/3d-sources/provider-packs/kenney' / source['pack_key'] / 'extracted' / source['source_relative_path']
        if path.suffix.lower() == '.fbx':
            bpy.ops.import_scene.fbx(filepath=str(path))
        else:
            bpy.ops.import_scene.gltf(filepath=str(path))
        imported = set(bpy.data.objects) - before
        for obj in imported:
            if obj.type == 'ARMATURE':
                obj.animation_data_clear()
                obj.data.pose_position = 'REST'
        bpy.context.view_layer.update()
        parts, updated, evidence = BINDING.bind_parts(bpy, bmesh, rig, imported, specification, canonical)
        assert all(obj.animation_data is None for obj in parts.values()), key + ': source node actions leaked into prepared meshes'
        assert updated['scalp_source_nodes'] == updated['head_nodes'], (key, updated['scalp_source_nodes'], updated['head_nodes'])
        assert all(abs(actual - target) < 1e-5 for pair, target_pair in zip(evidence['target_head_bounds'], expected) for actual, target in zip(pair, target_pair)), key
        if key == 'kenney-space-kit-astronautA':
            head = parts[updated['head_nodes'][0]]
            face = [vertex.co for polygon in head.data.polygons if polygon.material_index == 2 for index in polygon.vertices for vertex in [head.data.vertices[index]]]
            assert sum(point.y for point in face) / len(face) < 0, 'source face must point toward canonical -Y'
        print('已验证来源绑定', key)


# 已有旧Mage显式标注只覆盖头壳，Eyes与Jaw不能被新的Kenney映射覆盖。
def verify_legacy_scalp_annotation():
    source = next(item for item in json.loads((ROOT / 'scripts/legacy-kaykit-character-sources.json').read_text())['sources'] if item['key'] == 'kaykit-legacy-skeleton-mage')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin/character-medium-v1.glb'))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    canonical = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / '.local/3d-sources/provider-packs/kaykit/kaykit-skeleton-pack/extracted' / source['source_relative_path']))
    _, updated, _ = BINDING.bind_parts(bpy, bmesh, rig, set(bpy.data.objects) - before, source, canonical)
    assert len(updated['scalp_source_nodes']) == len(source['scalp_source_nodes']) == 1
    assert updated['scalp_source_nodes'] != updated['head_nodes']
    print('旧Mage的眼睛与下颚固定标注保持不变')


verify_representatives()
verify_legacy_scalp_annotation()
