"""用真实Kenney头部证明脸发分离及实际GLB的alpha材质和内嵌纹理。"""
import importlib.util
import json
from pathlib import Path
import struct

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('kenney_heads', ROOT / 'scripts/kenney-character-heads.py')
HEADS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEADS)


# 只在独立Blender进程中清空测试场景，源GLB不写回。
def import_source(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / path))
    return {obj.name: obj for obj in bpy.context.scene.objects if obj.type == 'MESH'}


# 面组只移走头发，原始眼、嘴与脸几何保留在独立固定头部。
def test_mini_face_groups():
    parts = import_source('.local/3d-sources/provider-packs/kenney/mini-characters/extracted/Models/GLB format/character-male-a.glb')
    source = parts['head-mesh']
    original_count = len(source.data.polygons)
    fixed, hair, evidence = HEADS.prepare_head_parts(bpy, bmesh, parts, {'key': 'kenney-mini-characters-male-a', 'head_nodes': ['head-mesh']})
    assert original_count == 273
    assert len(hair) == 1 and len(hair[0].data.polygons) == 77
    assert len(fixed[0].data.polygons) == original_count - 77
    assert len(source.data.polygons) == original_count
    assert fixed[0].data is not source.data and hair[0].data is not source.data
    assert fixed[0].vertex_groups.get('head') is not None
    assert hair[0].vertex_groups.get('head') is not None
    assert evidence['scalp_envelope_verified'] is False
    return evidence


# 实际导出的GLB保留MASK语义，纹理字节内嵌，脸底图与发型层不共用材质。
def test_painted_head_glb():
    parts = import_source('.local/3d-sources/provider-packs/kenney/blocky-characters/extracted/Models/GLB format/character-a.glb')
    fixed, hair, evidence = HEADS.prepare_head_parts(bpy, bmesh, parts, {'key': 'kenney-blocky-characters-a', 'head_nodes': ['head']})
    assert len(fixed) == len(hair) == 1
    assert fixed[0].data.materials[0] is not hair[0].data.materials[0]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in fixed + hair:
        obj.select_set(True)
    output = ROOT / '.local/3d-sources/character-inspection/kenney/heads-test.glb'
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True, export_animations=False)
    data = output.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    assert any(material.get('alphaMode') == 'MASK' for material in document['materials'])
    assert len(document['images']) == 2
    assert all('bufferView' in image and 'uri' not in image for image in document['images'])
    assert evidence['scalp_envelope_verified'] is False
    return evidence


results = {'mini': test_mini_face_groups(), 'painted': test_painted_head_glb()}
(ROOT / '.local/3d-sources/character-inspection/kenney/heads-test-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
print('真实头部面组与GLB贴图分层测试通过；尚未验证统一头皮包络及跨角色穿戴。')
