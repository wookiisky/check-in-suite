"""在独立后台 Blender 中读取 FBX 动作，并保留真实静态绑定节点。"""

import hashlib
from pathlib import Path
import tempfile


# 转换产物只在制作目录暂存，正式动作由统一导入器重新写成无网格GLB。
def read_fbx_document(path, read_document):
    import bpy

    directory = Path(__file__).resolve().parents[1] / '.local/3d-sources/provider-animation-work'
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='fbx-', dir=directory) as temporary:
        temporary = Path(temporary)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=str(path))
        armatures = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
        if len(armatures) != 1:
            raise ValueError('FBX动作必须有一套已审核的人形骨架')
        armature = armatures[0]
        # 动作FBX没有蒙皮，静态REST导出给出绑定节点，避免把动作首帧当绑定姿势。
        armature.data.pose_position = 'REST'
        rest_path = temporary / 'rest.glb'
        bpy.ops.export_scene.gltf(filepath=str(rest_path), export_format='GLB', export_animations=False)
        armature.data.pose_position = 'POSE'
        animation_path = temporary / 'animations.glb'
        bpy.ops.export_scene.gltf(filepath=str(animation_path), export_format='GLB', export_animations=True)
        rest, _ = read_document(rest_path)
        doc, blob = read_document(animation_path)
        rest_nodes = {node.get('name'): node for node in rest['nodes']}
        for node in doc['nodes']:
            original = rest_nodes[node['name']]
            for key in ('translation', 'rotation', 'scale', 'matrix'):
                node.pop(key, None)
                if key in original:
                    node[key] = original[key]
        for clip in doc.get('animations', []):
            clip['name'] = clip['name'].rsplit('|', 1)[-1]
        evidence = {
            'method': 'blender-fbx-actions-with-separate-rest-node-export',
            'blender_version': bpy.app.version_string,
            'source_fbx_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'converted_glb_sha256': hashlib.sha256(animation_path.read_bytes()).hexdigest(),
            'rest_glb_sha256': hashlib.sha256(rest_path.read_bytes()).hexdigest(),
        }
        return doc, blob, evidence
