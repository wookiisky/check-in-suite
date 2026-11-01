"""读取人物真实GLB或用Blender检查FBX，输出可追溯的网格与骨架证据。"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys


# 检查完整容器后读取JSON，不把无蒙皮的静态分肢模型当作已有绑定角色。
def glb_document(data):
    if len(data) < 20:
        raise ValueError('GLB容器截断')
    magic, version, length = struct.unpack_from('<III', data)
    size, kind = struct.unpack_from('<I4s', data, 12)
    if magic != 0x46546c67 or version != 2 or length != len(data) or kind != b'JSON' or 20 + size > len(data):
        raise ValueError('GLB容器头无效')
    return json.loads(data[20:20 + size])


# 标准Python入口仅抽取已有结构，不通过命名推断角色部位。
def inspect_glb(path):
    data = path.read_bytes()
    document = glb_document(data)
    return {
        'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(),
        'skins': document.get('skins', []),
        'mesh_nodes': [{k: node[k] for k in ['name', 'mesh', 'skin', 'translation', 'rotation', 'scale'] if k in node} for node in document.get('nodes', []) if 'mesh' in node],
        'bones': [document['nodes'][index].get('name', '') for skin in document.get('skins', []) for index in skin['joints']],
        'materials': [material.get('name', '') for material in document.get('materials', [])],
        'animations': [animation.get('name', '') for animation in document.get('animations', [])],
    }


# Blender入口报告世界空间边界、实际权重和UV范围，供离线适配配置使用。
def inspect_blender(path):
    import bpy
    from mathutils import Vector
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    if path.suffix.lower() == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    result = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'meshes': [], 'armatures': []}
    for obj in bpy.context.scene.objects:
        if obj.type == 'ARMATURE':
            result['armatures'].append({'name': obj.name, 'bones': [{'name': bone.name, 'parent': bone.parent.name if bone.parent else None, 'head': list(obj.matrix_world @ bone.head_local), 'tail': list(obj.matrix_world @ bone.tail_local)} for bone in obj.data.bones]})
        if obj.type != 'MESH':
            continue
        points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        uv = obj.data.uv_layers.active
        result['meshes'].append({
            'name': obj.name, 'vertices': len(obj.data.vertices), 'polygons': len(obj.data.polygons),
            'bounds_min': [min(point[i] for point in points) for i in range(3)],
            'bounds_max': [max(point[i] for point in points) for i in range(3)],
            'materials': [material.name if material else None for material in obj.data.materials],
            'groups': [group.name for group in obj.vertex_groups],
            'uv_range': [[min(loop.uv[i] for loop in uv.data), max(loop.uv[i] for loop in uv.data)] for i in range(2)] if uv else None,
        })
    return result


# 输出文件由调用者指定，检查动作不改原始源文件。
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='+', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--blender', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None)
    results = [(inspect_blender if args.blender else inspect_glb)(path) for path in args.paths]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'sources': results}, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
