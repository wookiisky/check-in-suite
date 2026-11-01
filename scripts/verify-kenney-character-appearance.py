"""烘焙人物真实蒙皮姿势并复用四向预览，证据与模型字节及穿戴配置绑定。"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import struct

ROOT = Path(__file__).resolve().parents[1]


# 制作期只读取自包含GLB，结构检查由已有资源校验入口负责。
def read_glb(path):
    data = path.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + size]), data[28 + size:]


# 运行时按骨名绑定动作；临时加入标准人物的skin让Blender采用相同骨骼采样。
def compose_animation_model(canonical_path, animation_path, clip_name, output):
    canonical, binary = read_glb(canonical_path)
    source, source_binary = read_glb(animation_path)
    clip = copy.deepcopy(next(item for item in source['animations'] if item['name'] == clip_name))
    binary += b'\0' * (-len(binary) % 4)
    offset = len(binary)
    view_offset = len(canonical['bufferViews'])
    accessor_offset = len(canonical['accessors'])
    for view in source['bufferViews']:
        canonical['bufferViews'].append({**view, 'buffer': 0, 'byteOffset': offset + view.get('byteOffset', 0)})
    for accessor in source['accessors']:
        canonical['accessors'].append({**accessor, 'bufferView': accessor['bufferView'] + view_offset})
    target_names = {node['name']: index for index, node in enumerate(canonical['nodes']) if node.get('name')}
    for sampler in clip['samplers']:
        sampler['input'] += accessor_offset
        sampler['output'] += accessor_offset
    for channel in clip['channels']:
        channel['target']['node'] = target_names[source['nodes'][channel['target']['node']]['name']]
    canonical['animations'] = [clip]
    binary += source_binary
    canonical['buffers'] = [{'byteLength': len(binary)}]
    document = json.dumps(canonical, separators=(',', ':')).encode()
    document += b' ' * (-len(document) % 4)
    binary += b'\0' * (-len(binary) % 4)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(document) + len(binary)) + struct.pack('<I4s', len(document), b'JSON') + document + struct.pack('<I4s', len(binary), b'BIN\0') + binary)


# 本地试加工模型优先，其余已交付服装与活动动作读取正式资源。
def model_path(workspace, asset_key):
    prepared = workspace / 'internal/assets/builtin' / (asset_key + '.glb')
    return prepared if prepared.exists() else ROOT / 'internal/assets/builtin' / (asset_key + '.glb')


# glTF导入发生名称冲突时只忽略Blender自动增加的数字后缀。
def original_name(name):
    base, separator, suffix = name.rpartition('.')
    return base if separator and suffix.isdigit() else name


# 每次组合都从实际GLB重新读取，不复用上一个人物的姿势或可见状态。
def bake_variant(workspace, definition, wearables, selected, pose, output):
    import bpy
    from mathutils import Matrix
    target_path = model_path(workspace, definition['model_asset_key'])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(target_path))
    target = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    target.animation_data_clear()
    target.data.pose_position = 'POSE'
    target_meshes = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    chosen = [wearables[key] for key in selected if key]
    covered = {region for wearable in chosen for region in wearable['covers']}
    fixed_names = list(definition['fixed_nodes'])
    for region, names in definition['body_regions'].items():
        if region not in covered:
            fixed_names.extend(names)
    visible = [target_meshes[name] for name in fixed_names]
    source_hashes = {str(target_path): hashlib.sha256(target_path.read_bytes()).hexdigest()}
    outfit_sources = {}
    for wearable in chosen:
        if not wearable['nodes']:
            continue
        asset = wearable['model_asset_key']
        if asset not in outfit_sources:
            path = model_path(workspace, asset)
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(path))
            outfit_sources[asset] = {original_name(obj.name): obj for obj in set(bpy.data.objects) - before if obj.type == 'MESH'}
            source_hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        for name in wearable['nodes']:
            obj = outfit_sources[asset][name]
            obj.parent = target
            obj.parent_type = 'OBJECT'
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.matrix_basis = Matrix.Identity(4)
            for modifier in obj.modifiers:
                if modifier.type == 'ARMATURE':
                    modifier.object = target
            visible.append(obj)
    animation = definition['animations'][pose]
    animation_path = model_path(workspace, animation['asset_key'])
    path = animation_path
    if animation['asset_key'] != 'character-medium-v1':
        path = output.parent / 'animation-sources' / (animation['asset_key'] + '-' + animation['clip'] + '.glb')
        compose_animation_model(model_path(workspace, 'character-medium-v1'), animation_path, animation['clip'], path)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    source = next(obj for obj in set(bpy.data.objects) - before if obj.type == 'ARMATURE')
    source.animation_data.action = None
    tracks = list(source.animation_data.nla_tracks)
    chosen_track = next(track for track in tracks if track.name == animation['clip'])
    for track in tracks:
        track.mute = track != chosen_track
    strip = chosen_track.strips[0]
    frame = int(strip.frame_start + (strip.frame_end - strip.frame_start) * (0 if pose == 'idle' else .35))
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    for bone in target.pose.bones:
        bone.matrix_basis = source.pose.bones[bone.name].matrix_basis.copy()
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    snapshots = []
    for obj in visible:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), preserve_all_data_layers=True, depsgraph=graph)
        snapshot = bpy.data.objects.new('snapshot_' + obj.name, mesh)
        bpy.context.collection.objects.link(snapshot)
        snapshot.matrix_world = obj.matrix_world.copy()
        snapshots.append(snapshot)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in snapshots:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = snapshots[0]
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True, export_animations=False)
    source_hashes[str(animation_path)] = hashlib.sha256(animation_path.read_bytes()).hexdigest()
    return {'source_sha256': source_hashes, 'clip': animation['clip'], 'frame': frame, 'wearables': selected, 'covered_regions': sorted(covered)}


# 静态五种发型组合检查四向轮廓，动作则使用相同Rogue套装排除服装变化。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT / '.local/kenney-characters/workspace')
    parser.add_argument('--only', action='append', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/kenney-characters/appearance')
    parser.add_argument('--size', type=int, default=192)
    parser.add_argument('--static-only', action='store_true')
    parser.add_argument('--reverse', action='store_true')
    parser.add_argument('--variant', action='append', choices=['own', 'bald', 'rogue', 'barbarian', 'knight', 'walk', 'sit', 'read', 'exercise', 'own-walk', 'own-sit', 'own-read', 'own-exercise', 'reverse', 'reverse-walk'])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None)
    catalog = json.loads((args.workspace / 'internal/character/character-catalog.json').read_text())
    wearables = {item['wearable_key']: item for item in catalog['wearables']}
    base = catalog['characters'][0]
    common = list(base['defaults'].values())
    jobs = []
    for key in args.only:
        definition = next(item for item in catalog['characters'] if item['character_key'] == key)
        variants = [('own', list(definition['defaults'].values()), 'idle'), ('bald', [None, *common[1:]], 'idle'), ('rogue', common, 'idle'), ('barbarian', ['hair-barbarian-v1', *common[1:]], 'idle'), ('knight', ['kaykit-adventurers-knight-hair', *common[1:]], 'idle')]
        if not args.static_only:
            variants.extend((pose, common, pose) for pose in ['walk', 'sit', 'read', 'exercise'])
            variants.extend(('own-' + pose, list(definition['defaults'].values()), pose) for pose in ['walk', 'sit', 'read', 'exercise'])
        if args.reverse:
            variants = [('reverse', list(definition['defaults'].values()), 'idle'), ('reverse-walk', list(definition['defaults'].values()), 'walk')]
            definition = base
        for variant, outfit, pose in variants:
            if args.variant and variant not in args.variant:
                continue
            identity = key + '-' + variant
            output = args.output / (identity + '.glb')
            evidence = bake_variant(args.workspace, definition, wearables, outfit, pose, output)
            jobs.append({'key': identity, 'model': str(output), 'output_directory': str(args.output / identity), 'variant': variant, **evidence})
    request = args.output / 'jobs.json'
    request.write_text(json.dumps({'settings': {'size': args.size, 'views': ['front', 'right', 'back', 'left'], 'padding': 1.18, 'elevation': .12, 'pose': 'rest'}, 'jobs': jobs, 'result_path': str(args.output / 'render-results.json')}, ensure_ascii=False, indent=2) + '\n')
    specification = importlib.util.spec_from_file_location('kenney_renderer', ROOT / 'scripts/render-gltf-previews.py')
    renderer = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(renderer)
    raise SystemExit(renderer.run_jobs(request))


if __name__ == '__main__':
    main()
