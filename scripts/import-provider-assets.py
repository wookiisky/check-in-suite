"""按审核清单接入可独立摆放的官方模型，保留源文件与每项处理结果。"""
import argparse
import base64
import csv
import hashlib
import importlib.util
import shutil
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = None
FORMATS = {'.glb': 0, '.gltf': 1, '.fbx': 2, '.obj': 3, '.dae': 4}
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
STATIC_PIPELINE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()  # 加工代码变化使旧缓存失效。


# 写入目标始终位于候选，来源ROOT只读。
def write_root():
    return OUTPUT_ROOT if OUTPUT_ROOT is not None else ROOT / '.local/asset-pipeline/static'


# 非glTF转换保守纳入包内材质和贴图，避免只按主模型字节复用。
def conversion_fingerprint(source, blender_version, dependency_root=None):
    directory = dependency_root or source.parent
    sidecars = {'.mtl', '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.tif', '.tiff', '.dds', '.webp'}
    files = {source} | {path for path in directory.rglob('*') if path.is_file() and path.suffix.lower() in sidecars}
    payload = {'tool': blender_version, 'pipeline': STATIC_PIPELINE_SHA256,
               'inputs': {str(path.resolve()): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(files)}}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


# 缓存有效须同时满足依赖和实际交付字节一致。
def conversion_cache_valid(target, fingerprint):
    try:
        cached = json.loads(target.with_suffix('.conversion.json').read_text())
        return cached['fingerprint'] == fingerprint and cached['sha256'] == hashlib.sha256(target.read_bytes()).hexdigest()
    except (OSError, ValueError, KeyError):
        return False


# 只有转换完成并读取真实输出后记录缓存。
def save_conversion_cache(target, fingerprint):
    target.with_suffix('.conversion.json').write_text(json.dumps({'fingerprint': fingerprint, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}))


# 同一模型的格式副本归为一项；不同命名的外观保持独立身份。
def discover_models(directory):
    candidates = {}
    for path in sorted(directory.rglob('*')):
        if path.suffix.lower() not in FORMATS or not path.is_file():
            continue
        model_id = path.stem
        for suffix in ('.gltf', '.glb', '.fbx', '.obj'):
            if model_id.lower().endswith(suffix):
                model_id = model_id[:-len(suffix)]
                break
        candidates.setdefault(model_id, []).append(path)
    return [{'model_id': key, 'source': str(sorted(paths, key=lambda p: (FORMATS[p.suffix.lower()], str(p)))[0]), 'format_sources': [str(p) for p in paths]} for key, paths in sorted(candidates.items())]


# 不明确的选择留在待审核状态，不能自动成为商品。
def model_decision(model_id, policy):
    if model_id in policy.get('include', []):
        return 'included', None
    if model_id in policy.get('exclude', {}):
        return 'excluded', policy['exclude'][model_id]
    return 'pending-review', 'model-not-reviewed'


# 同名版本仅允许相同字节；变化必须产生新的资源标识。
def write_immutable(path, data):
    if path.exists() and path.read_bytes() != data:
        raise ValueError(f'immutable-resource-changed: {path.name}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


# glTF 外链与 data URI 使用相同字节读取路径。
def uri_bytes(uri, directory):
    if uri.startswith('data:'):
        header, content = uri.split(',', 1)
        return base64.b64decode(content) if ';base64' in header else unquote(content).encode()
    path = (directory / unquote(uri)).resolve()
    return path.read_bytes()


# 读取实际容器；不把 GLB 的对齐填充计为缓冲内容。
def read_gltf(path):
    if path.suffix.lower() == '.gltf':
        document = json.loads(path.read_text())
        chunks = [uri_bytes(item['uri'], path.parent) for item in document.get('buffers', [])]
    else:
        data = path.read_bytes()
        if len(data) < 20 or struct.unpack_from('<III', data)[:2] != (0x46546C67, 2):
            raise ValueError('invalid-glb-header')
        document, binary, offset = None, b'', 12
        while offset < len(data):
            length, kind = struct.unpack_from('<II', data, offset)
            chunk = data[offset + 8:offset + 8 + length]
            if kind == 0x4E4F534A:
                document = json.loads(chunk)
            elif kind == 0x004E4942:
                binary = chunk
            offset += 8 + length
        if document is None:
            raise ValueError('glb-json-missing')
        chunks = [uri_bytes(item['uri'], path.parent) if 'uri' in item else binary[:item['byteLength']] for item in document.get('buffers', [])]
    offsets, binary = [], bytearray()
    for chunk in chunks:
        binary.extend(b'\0' * (-len(binary) % 4))
        offsets.append(len(binary))
        binary.extend(chunk)
    for view in document.get('bufferViews', []):
        view['byteOffset'] = view.get('byteOffset', 0) + offsets[view.get('buffer', 0)]
        view['buffer'] = 0
    document['buffers'] = [{'byteLength': len(binary)}]
    return document, bytes(binary)


# 四列矩阵相乘保持 glTF 的列主序约定。
def multiply(left, right):
    return [sum(left[k * 4 + row] * right[column * 4 + k] for k in range(4)) for column in range(4) for row in range(4)]


# 节点的 TRS 转为矩阵；不改变资源内已有的旋转与比例。
def node_matrix(node):
    if 'matrix' in node:
        return node['matrix']
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    rotation = [1 - 2 * (y*y + z*z), 2 * (x*y + z*w), 2 * (x*z - y*w), 0,
                2 * (x*y - z*w), 1 - 2 * (x*x + z*z), 2 * (y*z + x*w), 0,
                2 * (x*z + y*w), 2 * (y*z - x*w), 1 - 2 * (x*x + y*y), 0,
                *node.get('translation', [0, 0, 0]), 1]
    scale = node.get('scale', [1, 1, 1])
    for column in range(3):
        for row in range(3):
            rotation[column * 4 + row] *= scale[column]
    return rotation


# 缺少 accessor min/max 时从真实顶点计算，而非猜测体积。
def accessor_bounds(document, binary, index):
    accessor = document['accessors'][index]
    if 'min' in accessor and 'max' in accessor:
        return accessor['min'], accessor['max']
    view = document['bufferViews'][accessor['bufferView']]
    code, size = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}[accessor['componentType']]
    offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    stride = view.get('byteStride', size * 3)
    points = [struct.unpack_from('<' + code * 3, binary, offset + row * stride) for row in range(accessor['count'])]
    return [min(p[axis] for p in points) for axis in range(3)], [max(p[axis] for p in points) for axis in range(3)]


# 场景边界包含每个可见网格的世界变换，节点实例不会被遗漏。
def scene_bounds(document, binary):
    points = []
    def visit(index, parent):
        node = document['nodes'][index]
        matrix = multiply(parent, node_matrix(node))
        if 'mesh' in node:
            for primitive in document['meshes'][node['mesh']]['primitives']:
                if 'POSITION' not in primitive.get('attributes', {}):
                    continue
                lower, upper = accessor_bounds(document, binary, primitive['attributes']['POSITION'])
                for x in (lower[0], upper[0]):
                    for y in (lower[1], upper[1]):
                        for z in (lower[2], upper[2]):
                            points.append([matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis] for axis in range(3)])
        for child in node.get('children', []):
            visit(child, matrix)
    scene = document.get('scenes', [{}])[document.get('scene', 0)]
    for index in scene.get('nodes', []):
        visit(index, IDENTITY)
    if not points:
        raise ValueError('model-has-no-visible-geometry')
    return [[min(p[axis] for p in points), max(p[axis] for p in points)] for axis in range(3)]


# 将所有图片写入同一 binary buffer，正式读取不依赖源目录。
def embed_images(document, binary, directory):
    binary = bytearray(binary)
    for image in document.get('images', []):
        if 'uri' not in image:
            continue
        uri = image.pop('uri')
        data = uri_bytes(uri, directory)
        binary.extend(b'\0' * (-len(binary) % 4))
        image['bufferView'] = len(document.setdefault('bufferViews', []))
        image['mimeType'] = 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg' if data.startswith(b'\xff\xd8') else 'image/webp' if data[8:12] == b'WEBP' else 'image/ktx2' if data.startswith(b'\xabKTX') else None
        if image['mimeType'] is None:
            raise ValueError(f'unsupported-image-format: {uri}')
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)})
        binary.extend(data)
    document['buffers'] = [{'byteLength': len(binary)}]
    return bytes(binary)


# 编码后的长度和 chunk 对齐可由实际 GLB 消费者验证。
def glb_bytes(document, binary):
    content = json.dumps(document, separators=(',', ':')).encode()
    content += b' ' * (-len(content) % 4)
    binary += b'\0' * (-len(binary) % 4)
    total = 28 + len(content) + len(binary)
    return struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(content), 0x4E4F534A) + content + struct.pack('<II', len(binary), 0x004E4942) + binary


# 旧导出中的未引用临时父节点不属于场景，移除后再添加统一地面根节点。
def prune_inactive_nodes(document):
    scene = document['scenes'][document.get('scene', 0)]
    reachable = set()
    def visit(index):
        if index in reachable:
            return
        reachable.add(index)
        for child in document['nodes'][index].get('children', []):
            visit(child)
    for root in scene.get('nodes', []):
        visit(root)
    mapping = {old: new for new, old in enumerate(sorted(reachable))}
    nodes = [document['nodes'][index] for index in sorted(reachable)]
    for node in nodes:
        if 'children' in node:
            node['children'] = [mapping[child] for child in node['children']]
    for skin in document.get('skins', []):
        skin['joints'] = [mapping[joint] for joint in skin['joints']]
        if 'skeleton' in skin:
            skin['skeleton'] = mapping[skin['skeleton']]
    scene['nodes'] = [mapping[index] for index in scene.get('nodes', [])]
    document['nodes'] = nodes
    document['scenes'] = [scene]
    document['scene'] = 0


# 独立摆设只保留静态场景，根变换使原点落在地面中心并限制最大尺寸。
def prepare_gltf(source, target, max_extent=6, source_scale=1):
    document, binary = read_gltf(source)
    document.pop('animations', None)
    prune_inactive_nodes(document)
    source_bounds = scene_bounds(document, binary)
    extents = [upper - lower for lower, upper in source_bounds]
    if not all(math.isfinite(x) for pair in source_bounds for x in pair) or max(extents) <= 0:
        raise ValueError('invalid-model-bounds')
    scale = min(source_scale, max_extent / max(extents))
    translation = [-(source_bounds[0][0] + source_bounds[0][1]) / 2 * scale, -source_bounds[1][0] * scale, -(source_bounds[2][0] + source_bounds[2][1]) / 2 * scale]
    scene = document['scenes'][document.get('scene', 0)]
    root = {'name': 'ProviderGroundAnchor', 'translation': translation, 'scale': [scale] * 3, 'children': scene['nodes']}
    scene['nodes'] = [len(document['nodes'])]
    document['nodes'].append(root)
    document.pop('animations', None)
    binary = embed_images(document, binary, source.parent)
    result = glb_bytes(document, binary)
    write_immutable(target, result)
    return {'source_bounds_m': source_bounds, 'scale': scale, 'translation_m': translation, 'bounds_m': scene_bounds(document, binary), 'model_sha256': hashlib.sha256(result).hexdigest()}


# 外链缓冲和图片按实际字节参与指纹，源模型未变也不能漏掉依赖更新。
def preparation_fingerprint(source, max_extent, source_scale):
    document, binary = read_gltf(source)
    images = [hashlib.sha256(uri_bytes(image['uri'], source.parent)).hexdigest()
              for image in document.get('images', []) if 'uri' in image and not image['uri'].startswith('data:')]
    inputs = {'pipeline': STATIC_PIPELINE_SHA256, 'source': hashlib.sha256(source.read_bytes()).hexdigest(),
              'buffers': hashlib.sha256(binary).hexdigest(), 'images': images,
              'max_extent': max_extent, 'source_scale': source_scale}
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


# 只复用经字节校验的暂存产物；缓存损坏或加工失败都不会改变正式资源。
def prepare_gltf_cached(source, target, max_extent=6, source_scale=1):
    fingerprint = preparation_fingerprint(source, max_extent, source_scale)
    cache_path = target.with_suffix('.cache.json')
    try:
        cache = json.loads(cache_path.read_text())
        metadata = cache['metadata']
        metadata_hash = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
        if (cache['fingerprint'] == fingerprint and cache['metadata_sha256'] == metadata_hash
                and metadata['model_sha256'] == hashlib.sha256(target.read_bytes()).hexdigest()):
            return metadata
    except (OSError, ValueError, KeyError, TypeError):
        pass
    # 暂存文件可以重建；真正交付的不可变版本仍由 write_immutable 保护。
    target.unlink(missing_ok=True)
    metadata = prepare_gltf(source, target, max_extent, source_scale)
    metadata_hash = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
    cache_path.write_text(json.dumps({'fingerprint': fingerprint, 'metadata': metadata, 'metadata_sha256': metadata_hash}, sort_keys=True))
    return metadata


# 官方包内与单个模型同名的等轴测图来自实际模型，不使用包总览代替。
def official_thumbnail(directory, model_id):
    names = {model_id.casefold() + suffix for suffix in ('', '_ne', '_nw', '_se', '_sw')}
    matches = [p for p in directory.rglob('*.png') if p.stem.casefold() in names]
    matches = [p for p in matches if any(part.casefold() in ('isometric', 'previews', 'preview', 'renders') for part in p.parts)]
    return sorted(matches, key=lambda p: ('isometric' not in str(p).lower(), not p.stem.lower().endswith('_ne'), str(p)))[0] if matches else None


# 受控身份包含产物指纹，重加工不会覆盖已安装版本。
def slug(value, limit=38):
    return re.sub('[^a-z0-9]+', '-', value.lower()).strip('-')[:limit].rstrip('-') or 'model'


# 包清单始终是当前官方快照，转换失败保留在逐项报告中。
def inventory(pack_manifest, policy):
    records = []
    for pack in pack_manifest['packs']:
        if pack.get('status') != 'downloaded':
            continue
        directory = ROOT / pack['directory']
        for model in discover_models(directory):
            model['source'] = str(Path(model['source']).relative_to(ROOT))
            model['format_sources'] = [str(Path(source).relative_to(ROOT)) for source in model['format_sources']]
            key = pack['provider'] + '/' + pack['id']
            status, reason = model_decision(model['model_id'], policy.get('packs', {}).get(key, {}))
            records.append({**model, 'provider': pack['provider'], 'pack_key': pack['id'], 'pack_name': pack['name'], 'source_url': pack['source_url'], 'license': pack.get('license', 'CC0-1.0'), 'archive_sha256': pack.get('archive_sha256'), 'directory': pack['directory'], 'status': status, **({'reason': reason} if reason else {})})
    return records


# 图像渲染只读取准备后的交付模型；每项出错单独记录以便重试。
def render_jobs(jobs):
    import bpy
    from mathutils import Vector
    for job in jobs:
        try:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=job['model'])
            meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
            if not meshes:
                raise ValueError('no-renderable-mesh')
            corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
            center = Vector(tuple((min(p[i] for p in corners) + max(p[i] for p in corners)) / 2 for i in range(3)))
            scene = bpy.context.scene
            engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
            scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
            scene.render.resolution_x = scene.render.resolution_y = 256
            scene.render.resolution_percentage = 100
            scene.render.image_settings.file_format = 'PNG'
            scene.render.image_settings.color_mode = 'RGBA'
            scene.render.film_transparent = True
            scene.world = bpy.data.worlds.new('ProviderThumbnailWorld')
            scene.world.color = (.6, .6, .6)
            camera_data = bpy.data.cameras.new('ProviderThumbnailCamera')
            camera_data.type = 'ORTHO'
            camera = bpy.data.objects.new('ProviderThumbnailCamera', camera_data)
            scene.collection.objects.link(camera)
            camera.location = center + Vector((4, -6, 4))
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            rotation = camera.rotation_euler.to_matrix()
            width = max((point-center).dot(rotation.col[0]) for point in corners) - min((point-center).dot(rotation.col[0]) for point in corners)
            height = max((point-center).dot(rotation.col[1]) for point in corners) - min((point-center).dot(rotation.col[1]) for point in corners)
            camera_data.ortho_scale = max(width, height, .05) * 1.18
            camera_data.clip_end = 1000
            scene.camera = camera
            for name, position, energy, size in [('Key', (4, -5, 7), 700, 5), ('Fill', (-4, -1, 4), 400, 4)]:
                light_data = bpy.data.lights.new(name, 'AREA')
                light_data.energy = energy
                light_data.shape = 'DISK'
                light_data.size = size
                light = bpy.data.objects.new(name, light_data)
                scene.collection.objects.link(light)
                light.location = center + Vector(position)
                light.rotation_euler = (center-light.location).to_track_quat('-Z', 'Y').to_euler()
            scene.view_settings.view_transform = 'Standard'
            scene.render.filepath = job['thumbnail']
            bpy.ops.render.render(write_still=True)
        except Exception as error:
            print('素材缩略图失败', job['model'], str(error), flush=True)


# 少量没有 glTF 的完整模型先通过 Blender 转换，不把不支持格式算作已接入。
def convert_jobs(jobs):
    import bpy
    for job in jobs:
        try:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            suffix = Path(job['source']).suffix.lower()
            if suffix == '.fbx':
                bpy.ops.import_scene.fbx(filepath=job['source'])
            elif suffix == '.obj':
                bpy.ops.wm.obj_import(filepath=job['source'])
            elif suffix == '.dae':
                bpy.ops.wm.collada_import(filepath=job['source'])
            else:
                raise ValueError('unsupported-source-format')
            bpy.ops.export_scene.gltf(filepath=job['target'], export_format='GLB', export_animations=False, export_extras=False)
        except Exception as error:
            print('素材格式转换失败', job['source'], str(error), flush=True)


# 审核后的配置负责价格和空间，模型边界只提供实际占地尺寸。
def import_records(records, policy, blender=None):
    library = write_root() / '.local/3d-sources/provider-prepared/library'
    staging = write_root() / '.local/3d-sources/provider-prepared'
    staging.mkdir(parents=True, exist_ok=True)
    assets, definitions, jobs = [], [], []
    conversions = []
    converted = {}
    conversion_keys = {}
    blender_version = subprocess.run([blender, '--version'], capture_output=True, text=True, check=True).stdout if blender and any(Path(item.get('source', '')).suffix.lower() not in ('.glb', '.gltf') and item['status'] == 'included' for item in records) else 'unavailable'
    for record in records:
        source = ROOT / record['source']
        if record['status'] == 'included' and source.suffix.lower() not in ('.glb', '.gltf'):
            fingerprint = conversion_fingerprint(source, blender_version, ROOT / record['directory'])
            target = staging / ('converted-' + fingerprint[:24] + '.glb')
            conversion_keys[target] = fingerprint
            converted[str(source)] = target
            if not conversion_cache_valid(target, fingerprint):
                target.unlink(missing_ok=True)
                conversions.append({'source': str(source), 'target': str(target)})
    if conversions and blender:
        conversion_file = staging / 'conversion-jobs.json'
        conversion_file.write_text(json.dumps(conversions))
        subprocess.run([blender, '--background', '--factory-startup', '--python', str(Path(__file__).resolve()), '--', '--convert-jobs', str(conversion_file)], check=True, cwd=ROOT)
    for target, fingerprint in conversion_keys.items():
        if target.exists():
            try:
                read_gltf(target)
                save_conversion_cache(target, fingerprint)
            except (OSError, ValueError, struct.error, KeyError, TypeError):
                target.unlink(missing_ok=True)
    for record in records:
        if record['status'] != 'included':
            continue
        try:
            source = ROOT / record['source']
            pack_policy = policy['packs'][record['provider'] + '/' + record['pack_key']]
            pack_policy = {**pack_policy, **pack_policy.get('model_overrides', {}).get(record['model_id'], {})}
            original_source = source
            if source.suffix.lower() not in ('.glb', '.gltf'):
                source = converted.get(str(source))
                if source is None or not source.exists():
                    record.update(status='failed', reason='format-conversion-not-produced')
                    continue
            source_hash = hashlib.sha256(original_source.read_bytes()).hexdigest()
            temporary = staging / (hashlib.sha256(str(source).encode()).hexdigest() + '.glb')
            metadata = prepare_gltf_cached(source, temporary, pack_policy.get('max_extent_m', 6), pack_policy.get('source_scale', 1))
            item_key = slug(record['provider'], 8) + '-' + slug(record['pack_key'], 25) + '-' + slug(record['model_id'], 35)
            # Full source identity is hashed as well, so two truncated labels cannot collide.
            identity = hashlib.sha256((record['provider'] + '/' + record['pack_key'] + '/' + record['model_id']).encode()).hexdigest()[:6]
            item_key += '-' + identity
            preview = official_thumbnail(ROOT / record['directory'], record['model_id'])
            name = pack_policy.get('names', {}).get(record['model_id'], record['model_id'])
            base = dict(name=name, source_url=record['source_url'], license=record['license'], provider=record['provider'], pack_key=record['pack_key'], pack_name=record['pack_name'], category=pack_policy.get('category', 'decoration'))
            version = hashlib.sha256(json.dumps({'pipeline': 'static-v1', 'model': metadata['model_sha256'], 'metadata': base, 'thumbnail_source': hashlib.sha256(preview.read_bytes()).hexdigest() if preview else 'render-static-v1'}, sort_keys=True).encode()).hexdigest()[:8]
            model_key = item_key + '-' + version
            thumbnail_key = model_key + '-thumb'
            model_path = library / (model_key + '.glb')
            thumbnail_path = library / (thumbnail_key + '.png')
            write_immutable(model_path, temporary.read_bytes())
            if preview:
                write_immutable(thumbnail_path, preview.read_bytes())
            elif not thumbnail_path.exists():
                for prior in sorted(library.glob(item_key + '-*-thumb.png')):
                    prior_model = prior.with_name(prior.name.removesuffix('-thumb.png') + '.glb')
                    if prior_model.exists() and hashlib.sha256(prior_model.read_bytes()).hexdigest() == metadata['model_sha256']:
                        write_immutable(thumbnail_path, prior.read_bytes())
                        break
                if not thumbnail_path.exists():
                    jobs.append({'model': str(model_path), 'thumbnail': str(thumbnail_path)})
            assets.extend([{**base, 'key': model_key, 'kind': 'model', 'format': 'glb', 'url': '/api/v1/assets/' + model_key}, {**base, 'key': thumbnail_key, 'kind': 'island', 'format': 'png', 'url': '/api/v1/assets/' + thumbnail_key}])
            bounds = metadata['bounds_m']
            footprint = {'width_cm': max(5, math.ceil((bounds[0][1]-bounds[0][0])*100)), 'depth_cm': max(5, math.ceil((bounds[2][1]-bounds[2][0])*100))}
            blocks = pack_policy.get('blocks_placement', True)
            definitions.append({'item_key': item_key, 'name': name, 'thumbnail_asset_key': thumbnail_key, 'thumbnail_url': '/api/v1/assets/' + thumbnail_key, 'coin_price': pack_policy.get('coin_price', 20), 'diamond_price': 0, 'free': False, 'model_url': '/api/v1/assets/' + model_key, 'footprint': footprint, **({'walk_obstacle': footprint.copy()} if blocks else {}), 'blocks_placement': blocks, 'movable': True, 'repeatable': True, 'spaces': pack_policy.get('spaces', ['indoor', 'outdoor']), 'rotations': [0,1,2,3], 'allowed_terrain': ['grass','sand'], 'provider': record['provider'], 'pack_key': record['pack_key'], 'pack_name': record['pack_name'], 'category': pack_policy.get('category', 'decoration')})
            record.update(status='prepared', item_key=item_key, model_asset_key=model_key, thumbnail_asset_key=thumbnail_key, source_sha256=source_hash, thumbnail_source=str(preview.relative_to(ROOT)) if preview else 'rendered-from-delivery-model', **metadata)
        except Exception as error:
            record.update(status='failed', reason=str(error))
    if jobs and blender:
        job_file = staging / 'thumbnail-jobs.json'
        job_file.write_text(json.dumps(jobs))
        subprocess.run([blender, '--background', '--factory-startup', '--python', str(Path(__file__).resolve()), '--', '--render-jobs', str(job_file)], check=True, cwd=ROOT)
    for record in records:
        if record['status'] == 'prepared':
            thumbnail = library / (record['thumbnail_asset_key'] + '.png')
            if not thumbnail.exists():
                record.update(status='failed', reason='thumbnail-not-produced')
            else:
                record['thumbnail_sha256'] = hashlib.sha256(thumbnail.read_bytes()).hexdigest()
    ready = {record['item_key'] for record in records if record['status'] == 'prepared'}
    definitions = [item for item in definitions if item['item_key'] in ready]
    asset_keys = {item[key] for item in definitions for key in ('thumbnail_asset_key',)} | {item['model_url'].rsplit('/',1)[1] for item in definitions}
    return [item for item in assets if item['key'] in asset_keys], definitions


# 合并只添加新身份；已有受控目录和营地规则保持原值。
def merge_catalog(path, incoming, key, collection=None):
    document = json.loads(path.read_text())
    entries = document[collection] if collection else document
    indexed = {item[key]: item for item in entries}
    for item in incoming:
        if item[key] in indexed and indexed[item[key]] != item:
            prior = indexed[item[key]]
            if collection == 'catalog' and item.get('provider') in ('kaykit', 'kenney') and prior.get('provider') == item['provider']:
                entries[entries.index(prior)] = item
                indexed[item[key]] = item
            else:
                raise ValueError(f'existing-catalog-entry-changed: {item[key]}')
        if item[key] not in indexed:
            entries.append(item)
            indexed[item[key]] = item
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n')


# 源码只交付本轮最终版本；历史安装目录仍由运行时保留，不删除用户持久素材。
def prune_generated_versions(valid_keys):
    builtin = write_root() / 'internal/assets/builtin'
    generated = re.compile(r'^(?:kaykit|kenney)-.+-[0-9a-f]{6}-[0-9a-f]{8}(?:-thumb)?$')
    catalog_path = builtin / 'catalog.json'
    entries = json.loads(catalog_path.read_text())
    entries = [entry for entry in entries if not generated.fullmatch(entry['key']) or entry['key'] in valid_keys]
    catalog_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + '\n')
    for path in builtin.iterdir():
        if path.suffix in ('.png', '.glb') and generated.fullmatch(path.stem) and path.stem not in valid_keys:
            path.unlink()


# 本次发布清单与完整库分开；同一源对象不能重复占用名额。
def validate_selection(records, configuration):
    available = {(item['provider'], item['pack_key'], item['model_id']): item for item in records if item['status'] == 'prepared'}
    chosen = {}
    for item in configuration['items']:
        identity = (item['provider'], item['pack_key'], item['model_id'])
        if identity in chosen:
            raise ValueError(f'duplicate-selected-object: {identity}')
        if identity not in available:
            raise ValueError(f'selected-object-not-prepared: {identity}')
        chosen[identity] = item
    if len(chosen) != configuration['target_count']:
        raise ValueError('selected-object-count-does-not-match-configuration')
    return chosen


# 仅调整本次选入模型的米制比例，完整库的旧版本及未选入记录保持可追溯。
def resize_selection(records, assets, definitions, configuration):
    chosen = validate_selection(records, configuration)
    library = write_root() / '.local/3d-sources/provider-prepared/library'
    staging = write_root() / '.local/3d-sources/provider-prepared/selected-scale'
    staging.mkdir(parents=True, exist_ok=True)
    for record in records:
        selection = chosen.get((record['provider'], record['pack_key'], record['model_id']))
        if selection is None:
            continue
        target_scale = selection['source_scale']
        if not math.isfinite(target_scale) or target_scale <= 0:
            raise ValueError(f'invalid-selected-source-scale: {record["item_key"]}')
        if math.isclose(record['scale'], target_scale, abs_tol=1e-9):
            continue
        previous_key, previous_thumbnail = record['model_asset_key'], record['thumbnail_asset_key']
        source = library / (previous_key + '.glb')
        ratio = target_scale / record['scale']
        target = staging / (hashlib.sha256((previous_key + str(target_scale)).encode()).hexdigest() + '.glb')
        metadata = prepare_gltf_cached(source, target, selection.get('max_extent_m', 12), ratio)
        if not math.isclose(metadata['scale'], ratio, abs_tol=1e-9):
            raise ValueError(f'selected-scale-exceeds-extent: {record["item_key"]}')
        model_asset = next(item for item in assets if item['key'] == previous_key)
        image_asset = next(item for item in assets if item['key'] == previous_thumbnail)
        version = hashlib.sha256(json.dumps({'model': metadata['model_sha256'], 'thumbnail': record['thumbnail_sha256'], 'pipeline': 'selected-scale-v1'}, sort_keys=True).encode()).hexdigest()[:8]
        model_key = record['item_key'] + '-' + version
        thumbnail_key = model_key + '-thumb'
        write_immutable(library / (model_key + '.glb'), target.read_bytes())
        # 四视图的等比取景只依赖形状；等比缩放可复用同一模型已有的真实缩略图。
        write_immutable(library / (thumbnail_key + '.png'), (library / (previous_thumbnail + '.png')).read_bytes())
        assets[:] = [item for item in assets if item['key'] not in (previous_key, previous_thumbnail)]
        assets.extend([{**model_asset, 'key': model_key, 'url': '/api/v1/assets/' + model_key}, {**image_asset, 'key': thumbnail_key, 'url': '/api/v1/assets/' + thumbnail_key}])
        definition = next(item for item in definitions if item['item_key'] == record['item_key'])
        bounds = metadata['bounds_m']
        footprint = {'width_cm': max(5, math.ceil((bounds[0][1] - bounds[0][0]) * 100)), 'depth_cm': max(5, math.ceil((bounds[2][1] - bounds[2][0]) * 100))}
        definition.update(footprint=footprint, model_url='/api/v1/assets/' + model_key, thumbnail_asset_key=thumbnail_key, thumbnail_url='/api/v1/assets/' + thumbnail_key)
        if 'walk_obstacle' in definition:
            definition['walk_obstacle'] = footprint.copy()
        record.setdefault('previous_library_versions', []).append({key: record[key] for key in ('model_asset_key', 'thumbnail_asset_key', 'model_sha256', 'thumbnail_sha256', 'scale')})
        record.update(model_asset_key=model_key, thumbnail_asset_key=thumbnail_key, model_sha256=metadata['model_sha256'], bounds_m=bounds, scale=target_scale,
                      translation_m=[value * ratio for value in record.get('translation_m', [0, 0, 0])], scale_reason=selection['scale_reason'])


# 已整理的完整模型留在本地库，正式包只复制本次精选的不可变版本。
def publish_selection(records, assets, definitions, configuration, catalog_output=None):
    chosen = validate_selection(records, configuration)
    builtin = write_root()/'internal/assets/builtin'
    library = write_root()/'.local/3d-sources/provider-prepared/library'
    library.mkdir(parents=True, exist_ok=True)
    by_asset = {asset['key']: asset for asset in assets}
    by_definition = {item['item_key']: item for item in definitions}
    for asset in assets:
        filename = asset['key'] + '.' + asset['format']
        source, target = builtin/filename, library/filename
        if source.exists():
            if target.exists():
                if source.read_bytes() != target.read_bytes():
                    raise ValueError(f'local-library-version-changed: {asset["key"]}')
                source.unlink()
            else:
                source.rename(target)
        if not target.exists():
            raise ValueError(f'local-library-model-missing: {filename}')
    published_assets, published_definitions = [], []
    for record in records:
        if record['status'] != 'prepared':
            continue
        identity = (record['provider'], record['pack_key'], record['model_id'])
        selection = chosen.get(identity)
        record['selected'] = selection is not None
        record['selection_reason'] = selection['reason'] if selection else configuration['unselected_reason']
        record['library_model_path'] = str((library/(record['model_asset_key']+'.glb')).relative_to(write_root()))
        record['library_thumbnail_path'] = str((library/(record['thumbnail_asset_key']+'.png')).relative_to(write_root()))
        record['category'] = selection['category'] if selection else by_asset[record['model_asset_key']]['category']
        record['name'] = selection['name'] if selection else record['model_id']
        record.pop('published_model_asset_key', None)
        record.pop('published_thumbnail_asset_key', None)
        if not selection:
            continue
        model_asset = {**by_asset[record['model_asset_key']], 'name': selection['name'], 'category': selection['category']}
        thumbnail_asset = {**by_asset[record['thumbnail_asset_key']], 'name': selection['name'], 'category': selection['category']}
        version = hashlib.sha256(json.dumps({'library_model': record['model_sha256'], 'library_thumbnail': record['thumbnail_sha256'], 'metadata': model_asset, 'pipeline': 'selected-static-v1'}, sort_keys=True).encode()).hexdigest()[:8]
        model_key = record['item_key']+'-'+version
        thumbnail_key = model_key+'-thumb'
        for asset, key, source_key in [(model_asset, model_key, record['model_asset_key']), (thumbnail_asset, thumbnail_key, record['thumbnail_asset_key'])]:
            asset.update(key=key, url='/api/v1/assets/'+key)
            write_immutable(builtin/(key+'.'+asset['format']), (library/(source_key+'.'+asset['format'])).read_bytes())
            published_assets.append(asset)
        definition = {**by_definition[record['item_key']], 'name': selection['name'], 'category': selection['category'], 'coin_price': selection['coin_price'], 'spaces': selection['spaces'], 'model_url': '/api/v1/assets/'+model_key, 'thumbnail_asset_key': thumbnail_key, 'thumbnail_url': '/api/v1/assets/'+thumbnail_key}
        published_definitions.append(definition)
        record.update(published_model_asset_key=model_key, published_thumbnail_asset_key=thumbnail_key)
    if catalog_output is not None:
        # 附加片段与完整候选一并写入隔离输出，不触碰来源正式目录。
        catalog_output = write_root() / catalog_output.name
        catalog_output.parent.mkdir(parents=True, exist_ok=True)
        pattern = re.compile(r'^(?:kaykit|kenney)-.+-[0-9a-f]{6}-[0-9a-f]{8}(?:-thumb)?$')
        current = json.loads((builtin / 'catalog.json').read_text())
        selected_keys = {asset['key'] for asset in published_assets}
        retired = [asset['key'] for asset in current if pattern.fullmatch(asset['key']) and asset['key'] not in selected_keys]
        catalog_output.write_text(json.dumps({'assets': published_assets, 'definitions': published_definitions, 'retired_asset_keys': retired}, ensure_ascii=False, indent=2) + '\n')
    merge_catalog(builtin/'catalog.json', published_assets, 'key')
    # 旧的23件定义没有provider标记，完整保留；本次来源物件只发布精选项。
    scene_path = write_root()/'internal/island/spatial-scene.json'
    scene = json.loads(scene_path.read_text())
    scene['catalog'] = [item for item in scene['catalog'] if item.get('provider') not in ('kaykit', 'kenney')]+published_definitions
    scene_path.write_text(json.dumps(scene, ensure_ascii=False, indent=2)+'\n')
    prune_generated_versions({asset['key'] for asset in published_assets})
    return published_assets


# CSV由完整模型清单和本次精选配置导出，避免人工维护第二份选择事实。
def export_library_csv(records, configuration):
    fields = list(configuration['csv_headers'])
    with (write_root()/'internal/assets/provider-object-library.csv').open('w', newline='', encoding='utf-8-sig') as output:
        writer = csv.writer(output, lineterminator='\n')
        writer.writerow([configuration['csv_headers'][field] for field in fields])
        for record in records:
            if record['status'] == 'prepared':
                writer.writerow([record.get(field, '') for field in fields])


# 未审核条目也写入报告，确保包内模型总数可以逐项核对。
def main():
    global OUTPUT_ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/asset-pipeline/static')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'internal/assets/provider-pack-manifest.json')
    parser.add_argument('--policy', type=Path, default=ROOT / 'scripts/provider-static-policy.json')
    parser.add_argument('--inventory-only', action='store_true')
    parser.add_argument('--blender')
    parser.add_argument('--selection', type=Path, default=ROOT/'scripts/provider-release-selection.json')
    parser.add_argument('--publish-selection-only', action='store_true')
    parser.add_argument('--resize-selection-only', action='store_true')
    parser.add_argument('--catalog-output', type=Path)
    options = parser.parse_args()
    helper_spec = importlib.util.spec_from_file_location('static_candidate', Path(__file__).with_name('asset-pipeline-candidate.py'))
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    OUTPUT_ROOT = options.output.resolve()
    helper.validate_candidate_output(ROOT, OUTPUT_ROOT)
    if (OUTPUT_ROOT / 'candidate.json').exists():
        raise ValueError('candidate output already finalized; choose a new output directory')
    baseline = helper.capture_baseline(ROOT)
    for relative in ['internal/assets/builtin/catalog.json', 'internal/island/spatial-scene.json']:
        destination = OUTPUT_ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if (ROOT / relative).exists():
            shutil.copyfile(ROOT / relative, destination)
    if options.catalog_output is not None:
        options.catalog_output = OUTPUT_ROOT / options.catalog_output.name
    policy_paths = [options.policy] if options.policy.exists() else []
    default_policy = ROOT / 'scripts/provider-static-policy.json'
    if options.policy.resolve() == default_policy.resolve():
        policy_paths.extend(path for path in [default_policy.with_name('provider-static-policy-kaykit.json'), default_policy.with_name('provider-static-policy-kenney.json')] if path.exists())
    elif not options.policy.exists():
        raise FileNotFoundError(options.policy)
    dependency_paths = [Path(__file__), options.manifest, *policy_paths]
    if not options.inventory_only:
        dependency_paths.append(options.selection)
    dependencies = helper.capture_dependencies(ROOT, dependency_paths)
    packages = json.loads(options.manifest.read_text())
    policy = {'packs': {}}
    for path in policy_paths:
        policy['packs'].update(json.loads(path.read_text())['packs'])
    if options.publish_selection_only or options.resize_selection_only:
        previous = json.loads((ROOT/'internal/assets/provider-asset-manifest.json').read_text())
        dependencies.extend(helper.capture_dependencies(ROOT, [ROOT/'internal/assets/provider-asset-manifest.json']))
        records, assets = previous['items'], previous['assets']
        definitions = previous.get('definitions')
        if definitions is None:
            prepared_keys = {item['item_key'] for item in records if item['status'] == 'prepared'}
            definitions = [item for item in json.loads((ROOT/'internal/island/spatial-scene.json').read_text())['catalog'] if item['item_key'] in prepared_keys]
    else:
        records = inventory(packages, policy)
        source_paths = {ROOT / record['source'] for record in records if record['status'] == 'included'}
        dependency_paths = set(source_paths)
        for source in source_paths:
            try:
                dependency_paths.update(helper.source_dependencies(source))
            except (OSError, ValueError, struct.error):
                # 保留损坏主文件指纹，实际加工负责逐项失败，不能中断其他来源。
                pass
            if source.suffix.lower() not in ('.gltf', '.glb'):
                record = next(item for item in records if ROOT / item['source'] == source)
                dependency_paths.update(path for path in (ROOT / record['directory']).rglob('*') if path.is_file() and path.suffix.lower() in ['.mtl', '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.tif', '.tiff', '.dds', '.webp'])
        for record in records:
            if record['status'] == 'included':
                preview = official_thumbnail(ROOT / record['directory'], record['model_id'])
                if preview is not None:
                    dependency_paths.add(preview)
        dependencies.extend(helper.capture_dependencies(ROOT, sorted(path for path in dependency_paths if path.is_file())))
        assets, definitions = ([], []) if options.inventory_only else import_records(records, policy, options.blender)
    if options.publish_selection_only or options.resize_selection_only:
        library = write_root() / '.local/3d-sources/provider-prepared/library'
        for record in records:
            if record['status'] != 'prepared':
                continue
            for field, suffix in [('model_asset_key', '.glb'), ('thumbnail_asset_key', '.png')]:
                filename = record[field] + suffix
                target = library / filename
                if not target.exists():
                    source = ROOT / '.local/3d-sources/provider-prepared/library' / filename
                    if not source.exists():
                        source = ROOT / 'internal/assets/builtin' / filename
                    dependencies.extend(helper.capture_dependencies(ROOT, [source]))
                    write_immutable(target, source.read_bytes())
    published_assets = []
    failures = []
    if not options.inventory_only:
        configuration = json.loads(options.selection.read_text())
        # 批内任一加工失败时保留成功库文件，先写完整报告，不构建半套发布目录。
        if not any(item['status'] == 'failed' for item in records):
            try:
                if options.resize_selection_only or all('source_scale' in item for item in configuration['items']):
                    resize_selection(records, assets, definitions, configuration)
                published_assets = publish_selection(records, assets, definitions, configuration, options.catalog_output)
            except (ValueError, OSError) as error:
                failures.append({'stage': 'selection', 'reason': str(error)})
        export_library_csv(records, configuration)
    counts = {}
    for item in records:
        counts[item['status']] = counts.get(item['status'], 0) + 1
    report = {'snapshot_at': packages['snapshot_at'], 'scope': 'reviewed-standalone-3d-decorations', 'counts': counts, 'assets': assets, 'definitions': definitions, 'selected_assets': published_assets, 'selection': {'selected': sum(item.get('selected', False) for item in records), 'library_only': sum(item['status'] == 'prepared' and not item.get('selected', False) for item in records)}, 'items': records, 'failures': failures}
    (write_root()/'internal/assets/provider-asset-manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if not options.inventory_only and not counts.get('failed') and not failures:
        alias_script = Path(__file__).with_name('update-spatial-thumbnail-aliases.py')
        alias_spec = importlib.util.spec_from_file_location('provider_aliases', alias_script)
        alias_module = importlib.util.module_from_spec(alias_spec)
        alias_spec.loader.exec_module(alias_module)
        dependencies.extend(helper.capture_dependencies(ROOT, [alias_script]))
        previous_path = ROOT / 'internal/island/spatial-thumbnail-aliases.json'
        previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
        if previous_path.exists():
            dependencies.extend(helper.capture_dependencies(ROOT, [previous_path]))
        history = []
        for relative in ['internal/assets/provider-asset-manifest.json', 'internal/island/spatial-scene.json']:
            path = ROOT / relative
            if path.exists():
                dependencies.extend(helper.capture_dependencies(ROOT, [path]))
                history.append((relative, path.read_bytes()))
        candidate_manifest = write_root() / 'internal/assets/provider-asset-manifest.json'
        history.append(('candidate/internal/assets/provider-asset-manifest.json', candidate_manifest.read_bytes()))
        scene = json.loads((write_root() / 'internal/island/spatial-scene.json').read_text())
        current = {item['item_key']: item['thumbnail_asset_key'] for item in scene['catalog']}
        aliases = alias_module.build_aliases(current, previous, history)
        (write_root() / 'internal/island/spatial-thumbnail-aliases.json').write_text(json.dumps(aliases, ensure_ascii=False, indent=2) + '\n')
        helper.finalize_candidate(ROOT, OUTPUT_ROOT, 'provider', baseline=baseline, dependencies=dependencies)
    print(json.dumps(counts, ensure_ascii=False))
    return int(bool(counts.get('failed') or failures))


if __name__ == '__main__':
    if '--convert-jobs' in sys.argv:
        convert_jobs(json.loads(Path(sys.argv[sys.argv.index('--convert-jobs')+1]).read_text()))
    elif '--render-jobs' in sys.argv:
        render_jobs(json.loads(Path(sys.argv[sys.argv.index('--render-jobs')+1]).read_text()))
    else:
        raise SystemExit(main())
