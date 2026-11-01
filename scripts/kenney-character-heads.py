"""按逐源标注离线拆开头部贴图，发型透明层与固定脸部底图分别交付。"""
import argparse
from collections import deque
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# 种子、atlas范围与颜色容差来自外化的逐图审核；同色但不连通的眼睛保持原样。
def connected_hair_mask(image, bounds, seeds, tolerance):
    from PIL import Image
    x0, y0, x1, y1 = bounds
    if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
        raise ValueError('头部atlas范围超出原图')
    pixels = image.convert('RGB').load()
    colors = []
    for x, y in seeds:
        if not (x0 <= x < x1 and y0 <= y < y1):
            raise ValueError('头发种子不在已审核atlas内')
        colors.append(pixels[x, y])
    result = Image.new('L', image.size)
    mask = result.load()
    pending = deque(tuple(seed) for seed in seeds)
    visited = set()
    while pending:
        point = pending.popleft()
        if point in visited:
            continue
        visited.add(point)
        x, y = point
        if not (x0 <= x < x1 and y0 <= y < y1):
            continue
        color = pixels[x, y]
        if min(sum((a - b) ** 2 for a, b in zip(color, sample)) for sample in colors) > tolerance ** 2:
            continue
        mask[x, y] = 255
        pending.extend([(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)])
    return result


# 头发像素保留原色和透明度；原来被头发覆盖的头皮使用明确标注的肤色填补。
def split_head_texture(image, mask, skin_color):
    from PIL import Image
    image = image.convert('RGBA')
    hair = Image.new('RGBA', image.size)
    face = image.copy()
    for index, alpha in enumerate(mask.getdata()):
        if not alpha:
            continue
        point = (index % image.width, index // image.width)
        original = image.getpixel(point)
        hair.putpixel(point, original[:3] + (round(original[3] * alpha / 255),))
        face.putpixel(point, tuple(skin_color) + (original[3],))
    return hair, face


# 每项输出与原图hash绑定，重新运行可复现，不改动官方下载文件。
def prepare_heads(config, output):
    from PIL import Image
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for record in config['heads']:
        source = ROOT / record['texture_path']
        image = Image.open(source).convert('RGBA')
        if record.get('bald'):
            mask = Image.new('L', image.size)
        else:
            mask = connected_hair_mask(image, record['head_atlas_pixels'], record['hair_seeds'], record['color_tolerance'])
        skin = record.get('skin_rgb') or list(image.getpixel(tuple(record['skin_sample']))[:3])
        hair, face = split_head_texture(image, mask, skin)
        files = {}
        for kind, generated in [('mask', mask), ('hair', hair), ('face', face)]:
            path = output / (record['key'] + '-' + kind + '.png')
            generated.save(path)
            files[kind + '_path'] = str(path.relative_to(ROOT))
            files[kind + '_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        results.append({'key': record['key'], 'texture_path': record['texture_path'], 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'skin_rgb': skin, 'hair_pixels': sum(1 for alpha in mask.getdata() if alpha), **files})
    (output / 'manifest.json').write_text(json.dumps({'heads': results}, ensure_ascii=False, indent=2) + '\n')
    return results


# 每个头部副本保留既有权重与骨架引用，几何所有权不与原模型共享。
def copy_head(bpy, obj, suffix):
    result = obj.copy()
    result.data = obj.data.copy()
    result.name = obj.name + suffix
    bpy.context.collection.objects.link(result)
    return result


# 显式范围对应实际源三角面；需要保留的头皮只改UV，不删除脸部或眼睛。
def select_head_faces(bmesh, obj, selected, fill, skin_u, hair):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.faces.ensure_lookup_table()
    if not hair and fill:
        layer = mesh.loops.layers.uv.active
        if layer is None:
            raise ValueError('已标注的混合头皮缺少UV')
        for index in fill:
            for loop in mesh.faces[index].loops:
                loop[layer].uv.x = skin_u
    remove = [face for face in mesh.faces if (face.index not in selected if hair else face.index in selected and face.index not in fill)]
    bmesh.ops.delete(mesh, geom=remove, context='FACES')
    bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
    mesh.to_mesh(obj.data)
    mesh.free()


# 贴图发型使用明确的alpha裁剪节点，GLB导出时仍能区分头发与固定脸。
def head_texture_material(bpy, name, path, transparent):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    shader = nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Roughness'].default_value = .85
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = bpy.data.images.load(str(path), check_existing=True)
    texture.image.pack()
    output = nodes.new('ShaderNodeOutputMaterial')
    links = material.node_tree.links
    links.new(texture.outputs['Color'], shader.inputs['Base Color'])
    links.new(shader.outputs['BSDF'], output.inputs['Surface'])
    if transparent:
        clip = nodes.new('ShaderNodeMath')
        clip.operation = 'GREATER_THAN'
        clip.inputs[1].default_value = .5
        links.new(texture.outputs['Alpha'], clip.inputs[0])
        links.new(clip.outputs[0], shader.inputs['Alpha'])
        material.surface_render_method = 'DITHERED'
    return material


# 调用方须先完成统一绑定；本步骤仅按审核记录分离固定脸和发型，不承诺头皮包络已验收。
def prepare_head_parts(bpy, bmesh, parts, spec):
    key = spec['key']
    sources = [parts[name] for name in spec['head_nodes']]
    mini = json.loads((ROOT / 'scripts/kenney-mini-heads.json').read_text())['heads']
    selection = next((item for item in mini if item['key'] == key), None)
    if selection:
        if len(sources) != 1 or len(sources[0].data.polygons) != selection['source_polygon_count']:
            raise ValueError('源头部三角面数量与已审核记录不一致: ' + key)
        selected = {index for start, end in selection['hair_polygon_ranges'] for index in range(start, end)}
        fill = {index for start, end in selection['fixed_fill_polygon_ranges'] for index in range(start, end)}
        fixed = copy_head(bpy, sources[0], '_face')
        select_head_faces(bmesh, fixed, selected, fill, selection['fixed_fill_uv_u'], False)
        hair = []
        if selected:
            overlay = copy_head(bpy, sources[0], '_hair')
            select_head_faces(bmesh, overlay, selected, set(), None, True)
            for vertex in overlay.data.vertices:
                vertex.co += vertex.normal * .001
            hair.append(overlay)
        return [fixed], hair, {'method': 'reviewed-source-triangle-groups', 'fixed_polygons': len(fixed.data.polygons), 'hair_polygons': len(selected), 'fixed_fill_polygons': len(fill), 'source_sha256': selection['source_sha256'], 'head_landmark_bounds_blender': selection['head_landmark_bounds_blender'], 'scalp_envelope_verified': False}
    manifest = ROOT / '.local/3d-sources/character-inspection/kenney/head-masks/manifest.json'
    layers = json.loads(manifest.read_text())['heads'] if manifest.exists() else []
    layer = next((item for item in layers if item['key'] == key), None)
    if layer:
        face_material = head_texture_material(bpy, key + '_face', ROOT / layer['face_path'], False)
        hair_material = head_texture_material(bpy, key + '_hair', ROOT / layer['hair_path'], True) if layer['hair_pixels'] else None
        fixed, hair = [], []
        for obj in sources:
            face = copy_head(bpy, obj, '_face')
            face.data.materials.clear()
            face.data.materials.append(face_material)
            for polygon in face.data.polygons:
                polygon.material_index = 0
            fixed.append(face)
            if hair_material:
                overlay = copy_head(bpy, obj, '_hair')
                overlay.data.materials.clear()
                overlay.data.materials.append(hair_material)
                for polygon in overlay.data.polygons:
                    polygon.material_index = 0
                for vertex in overlay.data.vertices:
                    vertex.co += vertex.normal * .001
                hair.append(overlay)
        return fixed, hair, {'method': 'reviewed-painted-atlas-layers', 'hair_pixels': layer['hair_pixels'], 'source_texture_sha256': layer['source_sha256'], 'skin_rgb': layer['skin_rgb'], 'face_texture_sha256': layer['face_sha256'], 'hair_texture_sha256': layer['hair_sha256'], 'scalp_envelope_verified': False}
    if spec.get('head_separation', {}).get('method') == 'bald':
        return [copy_head(bpy, obj, '_face') for obj in sources], [], {'method': 'reviewed-bald-source', 'scalp_envelope_verified': False}
    raise ValueError('人物头部尚未完成语义标注: ' + key)


# 素材制作依赖Pillow，正式运行只使用生成的GLB与PNG。
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=ROOT / 'scripts/kenney-character-heads.json')
    parser.add_argument('--output', type=Path, default=ROOT / '.local/3d-sources/character-inspection/kenney/head-masks')
    args = parser.parse_args()
    records = prepare_heads(json.loads(args.config.read_text()), args.output)
    print(f'已拆分 {len(records)} 个人物头部贴图')


if __name__ == '__main__':
    main()
