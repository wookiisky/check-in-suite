"""将已审核 KayKit 输入制作为身体与六槽候选；不更新正式目录。"""
import argparse
import copy
import hashlib
import importlib.util
import json
import re
import shutil
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'scripts/modular-character-sources.json'
BUILTIN = ROOT / 'internal/assets/builtin'
WORK = ROOT / '.local/modular-character-work'


# 同一身份只允许同字节复用，产物内容参与身份计算。
def publish(data, suffix, label, metadata, directory=None):
    immutable = {key: value for key, value in metadata.items() if key not in ['key', 'url']}
    descriptor = json.dumps({**immutable, 'format': suffix}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    key = 'modular-' + label[:52] + '-' + hashlib.sha256(data + b'\0' + descriptor).hexdigest()[:12]
    path = (directory or BUILTIN) / (key + '.' + suffix)
    if path.exists() and path.read_bytes() != data:
        raise ValueError('immutable resource changed: ' + key)
    path.write_bytes(data)
    return key


# 去掉渲染耗时、日期等非像素元数据，使同配方图片能够安全重试。
def clean_png(data):
    result = data[:8]
    offset = 8
    while offset < len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        chunk = data[offset + 4:offset + 8]
        if chunk not in [b'tEXt', b'zTXt', b'iTXt', b'tIME']:
            result += data[offset:offset + 12 + length]
        offset += 12 + length
    return result


# 来源UV色块有已审核语义；不以显示名称或近似颜色判断衣物。
def body_surface(source_key, material_name, uv):
    if source_key.startswith('kaykit-legacy-skeleton'):
        return material_name.split('.')[0] in ['White', 'Black']
    if source_key.startswith('kaykit-skeleton'):
        return 0.125 <= uv[0] < 0.25 and 0.5 <= uv[1] < 0.75
    return uv[0] < 0.125 and uv[1] > 0.75


# 配方中的可读名称外化，脚本只处理部位和稳定身份。
def load_recipe(path=None):
    return json.loads((path or CONFIG).read_text())


# 按焊接位置取得连通面，材质或UV接缝不应把同一脸壳拆成碎片。
def connected_faces(obj):
    import bmesh

    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.faces.index_update()
    source_index = mesh.faces.layers.int.new('source_polygon')
    for face in mesh.faces:
        face[source_index] = face.index
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0005)
    remaining = set(mesh.verts)
    components = []
    while remaining:
        pending = [remaining.pop()]
        vertices = set(pending)
        while pending:
            vertex = pending.pop()
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                if other in remaining:
                    remaining.remove(other)
                    vertices.add(other)
                    pending.append(other)
        components.append({face[source_index] for vertex in vertices for face in vertex.link_faces})
    mesh.free()
    return components


# 在制作前核对实际输入，不把配方中旧哈希冒充本次已验证来源。
def verify_inputs(configuration, root=ROOT):
    declared = [configuration['canonical_input'], configuration['arrow_input']]
    declared.extend(configuration.get('canonical_hand_sources', {}).values())
    for reference_key in ['arm_skinning_reference', 'hand_surface_reference']:
        reference = configuration.get('human_body_shape', {}).get(reference_key)
        if reference:
            declared.append(reference)
    for source in configuration['sources']:
        declared.extend([{'path': source['source'], 'sha256': source['source_sha256']}, {'path': source['normalized_model'], 'sha256': source['normalized_sha256']}])
    verified = {}
    for item in declared:
        path = root / item['path']
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != item['sha256']:
            raise ValueError('source checksum mismatch: ' + item['path'])
        verified[item['path']] = actual
    return verified


# 全批次成功后才发布；写入失败恢复旧目录并移除本次新增文件。
def commit_outputs(staging, destination, updates, retired_names):
    files = sorted(staging.iterdir())
    for source in files:
        target = destination / source.name
        if target.exists() and target.read_bytes() != source.read_bytes():
            raise ValueError('immutable resource changed: ' + source.name)
    snapshots = {path: path.read_bytes() if path.exists() else None for path in updates}
    retired = {destination / name: (destination / name).read_bytes() for name in retired_names if (destination / name).exists()}
    created = []
    try:
        for source in files:
            target = destination / source.name
            if not target.exists():
                created.append(target)
                shutil.copyfile(source, target)
        for path, data in updates.items():
            path.write_bytes(data)
        for path in retired:
            path.unlink()
    except Exception:
        for path, data in snapshots.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        for path, data in retired.items():
            if not path.exists():
                path.write_bytes(data)
        for path in created:
            path.unlink(missing_ok=True)
        raise


# 所有制作入口共享候选清单实现，普通测试不加载 Blender。
def candidate_module():
    spec = importlib.util.spec_from_file_location('character_candidate', ROOT/'scripts/asset-pipeline-candidate.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 提前拒绝正式目录，防止渲染或暂存步骤覆盖源码。
def candidate_output(output):
    return candidate_module().validate_candidate_output(ROOT, output)


# 镜像写入候选；正式目录始终只读，复用的动作等资源单独登记。
def write_candidate(staging, output, updates, reused_assets=(), root=ROOT, baseline=None, dependencies=()):
    helper = candidate_module()
    output = helper.validate_candidate_output(root, output)
    baseline = helper.capture_baseline(root) if baseline is None else baseline
    destination = output/'internal/assets/builtin'
    destination.mkdir(parents=True, exist_ok=True)
    for source in sorted(staging.iterdir()):
        shutil.copyfile(source, destination/source.name)
    for path, data in updates.items():
        target = output/path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    reused = ['internal/assets/builtin/' + asset['key'] + '.' + (asset.get('format') or 'svg') for asset in reused_assets]
    return helper.finalize_candidate(root, output, 'characters', reused, baseline, dependencies)


# 实际制作集中在此入口，普通Python检查可以导入纯函数而无需安装bpy。
def prepare(options):
    import bpy
    import bmesh
    from mathutils import Matrix, Vector

    output = candidate_output(getattr(options, 'output', ROOT/'.local/asset-pipeline/characters'))
    if (output/'candidate.json').exists() or (output/'internal').exists():
        raise ValueError('candidate output already contains delivery; choose a new directory')
    baseline = candidate_module().capture_baseline(ROOT)
    work = output/'work'
    work.mkdir(parents=True, exist_ok=True)
    recipe = getattr(options, 'recipe', CONFIG)
    config = load_recipe(recipe)
    verified_inputs = verify_inputs(config)
    face_order = config.get('face_order')
    smile_source = config.get('human_face_source')
    smile_module = None
    if smile_source:
        smile_spec = importlib.util.spec_from_file_location('modular_smile_head', ROOT / 'scripts/modular-character-smile-head.py')
        smile_module = importlib.util.module_from_spec(smile_spec)
        smile_spec.loader.exec_module(smile_module)
    dependency_paths = [recipe, Path(__file__), *[path for path in ROOT.glob('scripts/modular-character-*.py') if 'test' not in path.name]]
    for path in verified_inputs:
        dependency_paths.extend(candidate_module().source_dependencies(ROOT/path))
    dependency_paths = list(dict.fromkeys(dependency_paths))
    dependencies = candidate_module().capture_dependencies(ROOT, dependency_paths)
    garment_waist = config.get('garment_waist_seam')
    clothing_module = None
    if config.get('upper_clothing_fit') or config.get('clothing_fit') or garment_waist:
        clothing_module_spec = importlib.util.spec_from_file_location('modular_clothing_fit', ROOT / 'scripts/modular-character-clothing-fit.py')
        clothing_module = importlib.util.module_from_spec(clothing_module_spec)
        clothing_module_spec.loader.exec_module(clothing_module)
    back_fit_module = None
    if config.get('back_clothing_fit'):
        back_fit_spec = importlib.util.spec_from_file_location('modular_back_fit', ROOT / 'scripts/modular-character-back-fit.py')
        back_fit_module = importlib.util.module_from_spec(back_fit_spec)
        back_fit_spec.loader.exec_module(back_fit_module)
    neck_fit_module = None
    if config.get('body_neck_support'):
        neck_fit_spec = importlib.util.spec_from_file_location('modular_neck_fit', ROOT / 'scripts/modular-character-head-fit.py')
        neck_fit_module = importlib.util.module_from_spec(neck_fit_spec)
        neck_fit_spec.loader.exec_module(neck_fit_module)
    hood_fit_module = None
    if config.get('head_clothing_fit'):
        hood_fit_spec = importlib.util.spec_from_file_location('modular_hood_fit', ROOT / 'scripts/modular-character-hood-fit.py')
        hood_fit_module = importlib.util.module_from_spec(hood_fit_spec)
        hood_fit_spec.loader.exec_module(hood_fit_module)
    helmet_opening = config.get('helmet_opening', {})
    if helmet_opening:
        helmet_spec = importlib.util.spec_from_file_location('modular_headwear_adjustments', ROOT / 'scripts/modular-character-headwear-adjustments.py')
        helmet_module = importlib.util.module_from_spec(helmet_spec)
        helmet_spec.loader.exec_module(helmet_module)
    mage_waist = config.get('mage_waist', {})
    if mage_waist:
        mage_spec = importlib.util.spec_from_file_location('modular_mage_waist', ROOT / 'scripts/modular-character-mage-waist.py')
        mage_module = importlib.util.module_from_spec(mage_spec)
        mage_spec.loader.exec_module(mage_module)
    waist_fit_module = None
    if config.get('skeleton_waist_fit'):
        waist_fit_spec = importlib.util.spec_from_file_location('modular_skeleton_waist_fit', ROOT / 'scripts/modular-character-skeleton-waist-fit.py')
        waist_fit_module = importlib.util.module_from_spec(waist_fit_spec)
        waist_fit_spec.loader.exec_module(waist_fit_module)
    human_waist_module = None
    if config.get('human_waist_fit'):
        human_waist_spec = importlib.util.spec_from_file_location('modular_human_waist_fit', ROOT / 'scripts/modular-character-human-waist-fit.py')
        human_waist_module = importlib.util.module_from_spec(human_waist_spec)
        human_waist_spec.loader.exec_module(human_waist_module)
    garment_waist_module = None
    if garment_waist:
        spec = importlib.util.spec_from_file_location('modular_waist_seam', ROOT / 'scripts/modular-character-waist-seam.py')
        garment_waist_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(garment_waist_module)
    staging = work / 'staged-assets'
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    base = config['canonical']
    assets = []
    wearables = []
    evidence = []
    face_completions = []
    human_body_evidence = None
    clothing_fit_evidence = []
    back_fit_evidence = []
    neck_support_evidence = {}
    head_fit_evidence = []
    mage_waist_evidence = []
    human_waist_evidence = None
    hand_surface = None
    aliases = {}
    fingerprints = {}
    produced = []
    body_definitions = []
    rig = None

    # 读取标准化源，动画只在共享动作文件中使用。
    def load(path):
        nonlocal rig
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / path))
        rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
        rig.animation_data_clear()
        rig.data.pose_position = 'REST'
        objects = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH' and len(obj.data.polygons)}
        for name, obj in objects.items():
            obj.name = '_source_' + name
        return objects

    # 复制保留实际UV、材质与蒙皮；空顶点在删面后清除。
    def select(source, name, predicate):
        obj = source.copy()
        obj.data = source.data.copy()
        obj.name = name
        obj.animation_data_clear()
        bpy.context.collection.objects.link(obj)
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        layer = mesh.loops.layers.uv.active
        remove = [face for face in mesh.faces if not predicate(face, layer)]
        bmesh.ops.delete(mesh, geom=remove, context='FACES')
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.to_mesh(obj.data)
        mesh.free()
        return obj

    # UV 区域声明用于辨认已审核的来源部件。
    def in_uv_regions(uv, regions):
        return any(u0 <= uv[0] < u1 and v0 <= uv[1] <= v1 for u0, u1, v0, v1 in regions)

    # 按已审核源色块拆开人体与衣物，也可排除不属于穿戴的人工封盖。
    def anatomical(source, source_key, keep_body, name, excluded_uv=()):
        def chosen(face, layer):
            uv = sum((loop[layer].uv for loop in face.loops), Vector((0, 0))) / len(face.loops) if layer else (0, 0)
            material = source.data.materials[face.material_index].name if source.data.materials else ''
            return body_surface(source_key, material, uv) == keep_body and not in_uv_regions(uv, excluded_uv)
        return select(source, name, chosen)

    # 腕切面的人工封盖不属于手套，保留源衣物的真实开放接口。
    def open_wrist(obj, wrist):
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        caps = [face for face in mesh.faces if all(abs(abs(vertex.co.x) - wrist) < .00001 for vertex in face.verts)]
        bmesh.ops.delete(mesh, geom=caps, context='FACES')
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.to_mesh(obj.data)
        mesh.free()

    # 从源手部取真实手套或护手，原版整条手臂只切出腕外部分且不补封面。
    def hand_clothing(source, source_key, name, wrist, body_uv_regions=()):
        part = anatomical(source, source_key, False, name)
        if body_uv_regions:
            def clothing_surface(face, layer):
                uv = sum((loop[layer].uv for loop in face.loops), Vector((0, 0))) / len(face.loops)
                return not any(low_u <= uv.x <= high_u and low_v <= uv.y <= high_v for low_u, high_u, low_v, high_v in body_uv_regions)
            part = select(part, name, clothing_surface)
        if not part.data.polygons:
            return None
        if min(abs(vertex.co.x) for vertex in part.data.vertices) < wrist - .00001:
            side = 1 if sum(vertex.co.x for vertex in part.data.vertices) >= 0 else -1
            mesh = bmesh.new()
            mesh.from_mesh(part.data)
            bmesh.ops.bisect_plane(mesh, geom=list(mesh.verts) + list(mesh.edges) + list(mesh.faces), plane_co=Vector((side * wrist, 0, 0)), plane_no=Vector((side, 0, 0)), clear_inner=True, dist=.000001)
            bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
            mesh.to_mesh(part.data)
            mesh.free()
        open_wrist(part, wrist)
        if not part.data.polygons:
            return None
        # 原版来源与规范骨架的绑定姿势相同，仅改骨架引用，保留所有手指权重。
        world = part.matrix_world.copy()
        part.parent = rig
        part.parent_type = 'OBJECT'
        part.matrix_parent_inverse = Matrix.Identity(4)
        part.matrix_world = world
        for modifier in part.modifiers:
            if modifier.type == 'ARMATURE':
                modifier.object = rig
        return part

    # 同一部位合并真实网格，保持头皮独立供显隐规则使用。
    def join(objects, name):
        objects = [obj for obj in objects if len(obj.data.polygons)]
        if not objects:
            return None
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = name
        obj.data.name = name + '_mesh'
        return obj

    # 静态附件使用显式骨骼绑定，不依赖运行时重定向。
    def bind(obj, bone):
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.data.transform(world)
        obj.matrix_world = Matrix.Identity(4)
        obj.vertex_groups.clear()
        obj.vertex_groups.new(name=bone).add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
        obj.modifiers.clear()
        obj.parent = rig
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = Matrix.Identity(4)
        obj.modifiers.new('CharacterRig', 'ARMATURE').object = rig

    # 材质颜色采样仅用于重复外观比较，不参与人体分类。
    def polygon_color(obj, polygon):
        if not obj.data.materials:
            return (0.8, 0.8, 0.8)
        mat = obj.data.materials[polygon.material_index]
        image = next((node.image for node in mat.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image), None) if mat.use_nodes else None
        if image and obj.data.uv_layers.active:
            uv = obj.data.uv_layers.active.data[polygon.loop_indices[0]].uv
            width, height = image.size
            offset = (min(height - 1, max(0, int(uv.y * height))) * width + min(width - 1, max(0, int(uv.x * width)))) * 4
            return tuple(round(value, 3) for value in image.pixels[offset:offset + 3])
        return tuple(round(value, 3) for value in mat.diffuse_color[:3])

    # 只有几何与实际着色一致的同槽部件才共用商品。
    def fingerprint(objects):
        triangles = []
        for obj in objects:
            obj.data.calc_loop_triangles()
            colors = {face.index: polygon_color(obj, face) for face in obj.data.polygons}
            for triangle in obj.data.loop_triangles:
                vertices = sorted(tuple(round(value, 4) for value in obj.data.vertices[index].co) for index in triangle.vertices)
                triangles.append((vertices, colors[triangle.polygon_index]))
        return hashlib.sha256(json.dumps(sorted(triangles), separators=(',', ':')).encode()).hexdigest()

    # 所有缩略图来自本次实际交付对象，禁止用旧角色整图冒充衣物。
    def render(objects, label, metadata, name, kind='wearable'):
        for obj in bpy.data.objects:
            if obj.type == 'MESH':
                obj.hide_render = obj not in objects
        points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
        center = Vector(tuple((min(p[i] for p in points) + max(p[i] for p in points)) / 2 for i in range(3)))
        height = max(max(p[i] for p in points) - min(p[i] for p in points) for i in range(3))
        scene = bpy.context.scene
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = 8
        scene.render.resolution_x = scene.render.resolution_y = 256
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.film_transparent = True
        scene.world = bpy.data.worlds.new('PreviewWorld') if scene.world is None else scene.world
        scene.world.color = (0.45, 0.45, 0.45)
        for prop in scene.render.bl_rna.properties:
            if prop.identifier.startswith('use_stamp'):
                setattr(scene.render, prop.identifier, False)
        camera_data = bpy.data.cameras.new('PreviewCamera')
        camera_data.type = 'ORTHO'
        camera_data.ortho_scale = max(height * 1.3, 0.3)
        camera = bpy.data.objects.new('PreviewCamera', camera_data)
        bpy.context.collection.objects.link(camera)
        camera.location = center + Vector((2.6, -5, 2.2)) * max(height, 0.5)
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.camera = camera
        lights = []
        for location, energy, size in [((3, -4, 6), 650, 4), ((-3, -1, 3), 400, 3), ((0, 4, 5), 600, 3)]:
            data = bpy.data.lights.new('PreviewLight', 'AREA')
            data.energy, data.shape, data.size = energy, 'DISK', size
            light = bpy.data.objects.new('PreviewLight', data)
            bpy.context.collection.objects.link(light)
            light.location = center + Vector(location)
            light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
            lights.append(light)
        path = work / (label + '.png')
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        for obj in [camera, *lights]:
            bpy.data.objects.remove(obj, do_unlink=True)
        for obj in bpy.data.objects:
            if obj.type == 'MESH':
                obj.hide_render = False
        return publish(clean_png(path.read_bytes()), 'png', label, {**metadata, 'name': name, 'kind': kind}, directory=staging)

    # 交付只包含选定蒙皮和标准骨架，所有骨骼矩阵保持不变。
    def export(objects, label, metadata):
        bpy.ops.object.select_all(action='DESELECT')
        rig.select_set(True)
        for obj in objects:
            if not obj.data.polygons:
                raise ValueError('empty exported mesh: ' + obj.name)
            if any(sum(group.weight for group in vertex.groups) < 0.99 for vertex in obj.data.vertices):
                raise ValueError('unweighted exported mesh: ' + obj.name)
            obj.select_set(True)
        bpy.context.view_layer.objects.active = rig
        path = work / (label + '.glb')
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_def_bones=False)
        key = publish(path.read_bytes(), 'glb', label, {**metadata, 'name': label, 'kind': 'model'}, directory=staging)
        assets.append({**metadata, 'key': key, 'name': label, 'kind': 'model', 'url': '/api/v1/assets/' + key, 'format': 'glb'})
        return key

    # 构建独立商品，同时记录实际剥离数量，默认与重复项由后面统一处理。
    def item(key, name, slot, objects, source_key, metadata, covers=None, hand_objects=(), deliver=True, regions=None):
        objects = [obj for obj in objects if obj is not None and len(obj.data.polygons)]
        adjustments = config.get('clothing_fit', {}).get(key)
        if adjustments is None and slot == 'upper':
            # 旧上装配方继续适用；显式通用配方可复用同一算法适配披肩等部件。
            adjustments = config.get('upper_clothing_fit', {}).get(key)
        if adjustments:
            fitted = clothing_module.fit_upper_clothing(objects, rig, adjustments, hand_objects=hand_objects, hand_surface=hand_surface)
            clothing_fit_evidence.append({'wearable_key': key, 'adjustments': copy.deepcopy(adjustments), **fitted})
        waist_settings = None
        if garment_waist:
            default_waist = garment_waist['standard_lower'] if slot == 'lower' else None
            waist_settings = garment_waist['items'].get(key, default_waist)
        if waist_settings:
            # 上装的手套是随附节点，躯干衣片由制作入口排在首位。
            waist_obj = objects[0]
            vertices = range(len(waist_obj.data.vertices))
            if waist_settings.get('main_component'):
                component = max(clothing_module.mesh_components(waist_obj), key=lambda part: len(part['faces']))
                vertices = component['vertices']
            garment_waist_module.fit_waist_seam(waist_obj, vertices, waist_settings, garment_waist['height'], garment_waist['weights'])
        back_settings = config.get('back_clothing_fit', {}).get(key)
        if back_settings:
            for obj in objects:
                fitted = back_fit_module.fit_back_neck(obj, rig, back_settings)
                back_fit_evidence.append({'wearable_key': key, 'node': obj.name, 'settings': copy.deepcopy(back_settings), **fitted})
        head_settings = config.get('head_clothing_fit', {}).get(key)
        if slot == 'head' and head_settings:
            for obj in objects:
                fitted = hood_fit_module.fit_hood_cheeks(obj, rig, head_settings)
                head_fit_evidence.append({'wearable_key': key, 'node': obj.name, 'settings': copy.deepcopy(head_settings), **fitted})
        signature = (slot, fingerprint(objects), tuple(covers or []))
        if signature in fingerprints:
            aliases[key] = fingerprints[signature]
            return None
        fingerprints[signature] = key
        result = dict(wearable_key=key, name=name, slot=slot, character_key='kaykit-medium-v1', body_key=config['body_key'], rig_key=config['rig_key'], provider='kaykit', pack_key=metadata['pack_key'], nodes=[obj.name for obj in objects], covers=covers or [])
        if regions is not None:
            result['_regions'] = regions
        elif slot == 'face':
            result['_regions'] = {'scalp': objects[1:]}
        result['_objects'] = objects
        result['_source'] = source_key
        result['_metadata'] = metadata
        result['_deliver'] = deliver
        if deliver:
            produced.append(result)
        return result

    # 导出当前场景批次，模型可包含多个独立商品但不会成为角色身份。
    def finish(items, extra, label, metadata, thumbnail_omit=None):
        objects = list(dict.fromkeys(extra + [obj for entry in items if entry for obj in entry['_objects']]))
        for obj in objects:
            obj.name = re.sub(r'[^A-Za-z0-9_-]', '', obj.name)
        for entry in items:
            if entry:
                entry['nodes'] = [obj.name for obj in entry['_objects']]
                if '_regions' in entry:
                    entry['regions'] = {region: [obj.name for obj in parts] for region, parts in entry['_regions'].items()}
        model_key = export(objects, label, metadata)
        for entry in items:
            if entry is None or not entry['_deliver']:
                continue
            thumbnail_objects = [obj for obj in entry['_objects'] if obj != thumbnail_omit]
            thumb = render(thumbnail_objects, entry['wearable_key'], metadata, entry['name'])
            assets.append({**metadata, 'key': thumb, 'name': entry['name'], 'kind': 'wearable', 'url': '/api/v1/assets/' + thumb, 'format': 'png'})
            entry.update(model_asset_key=model_key, model_url='/api/v1/assets/' + model_key, thumbnail_asset_key=thumb, thumbnail_url='/api/v1/assets/' + thumb)
        return model_key

    # 基础人形的脸和默认衣物独立，裸身由配方生成。
    objects = load(config['canonical_input']['path'])
    meta = {key: config['canonical_asset'][key] for key in ['source_url', 'license', 'provider', 'pack_key']}
    items = []
    face_head = select(objects['body_head'], 'face_head', lambda f, uv: True)
    face_scalp = select(objects['body_scalp'], 'face_scalp', lambda f, uv: True)
    items.append(item('face-human-default-v1', config['labels']['face_default'], 'face', [face_head, face_scalp], 'canonical', meta, ['head', 'scalp'], deliver=not smile_source))
    for slot, source_name, key, name in config['canonical_wearables']:
        part = select(objects[source_name], source_name, lambda f, uv: True) if slot == 'head' else anatomical(objects[source_name], 'canonical', False, source_name)
        pieces = [part]
        hand_parts = []
        if slot == 'upper':
            removed_body_faces = len(objects[source_name].data.polygons) - len(part.data.polygons)
            declaration = config['canonical_hand_sources'][key]
            hand_sources = objects
            if declaration['path'] != config['canonical_input']['path']:
                before = set(bpy.data.objects)
                bpy.ops.import_scene.gltf(filepath=str(ROOT / declaration['path']))
                hand_sources = {obj.name.split('.')[0]: obj for obj in set(bpy.data.objects) - before if obj.type == 'MESH'}
            hands = [hand_clothing(hand_sources[node], 'canonical', 'upper_hands_' + str(index), declaration['wrist_abs_x']) for index, node in enumerate(declaration['nodes'])]
            hands = join([obj for obj in hands if obj is not None], 'upper_hands')
            if hands is not None:
                open_wrist(part, declaration['wrist_abs_x'])
                pieces.append(hands)
                hand_parts.append(hands)
            evidence.append({'wearable_key': key, 'slot': slot, 'native': False, 'removed_body_faces': removed_body_faces, 'remaining_body_faces': len(anatomical(part, 'canonical', True, '_body_check').data.polygons), 'hand_faces': len(hands.data.polygons) if hands is not None else 0})
        items.append(item(key, name, slot, pieces, 'canonical', meta, config['wearable_covers'][key] if slot in ['head', 'shoes'] else [], hand_objects=hand_parts))
    # 先提取原款衣物及手套，再用平滑裸身替换衣物式支撑身体。
    if config.get('human_body_shape'):
        body_module_spec = importlib.util.spec_from_file_location('modular_body_shaping', ROOT / 'scripts/modular-character-body-shaping.py')
        body_module = importlib.util.module_from_spec(body_module_spec)
        body_module_spec.loader.exec_module(body_module)
        human_body_evidence = body_module.apply_human_body(objects, rig, config['human_body_shape'])
        human_body_evidence['profile'] = copy.deepcopy(config['human_body_shape'])
        if clothing_module is not None:
            # 跨场景重置只保留数值，让后续掌套始终适配本次实际裸手。
            hand_surface = clothing_module.capture_hand_surface(objects['body_hands'])
            hand_surface['arm_surface'] = clothing_module.capture_hand_surface(objects['body_arms'])
    if config.get('human_waist_fit'):
        human_waist_evidence = human_waist_module.fit_human_waist(objects, rig, config['human_waist_fit'])
    neck_settings = config.get('body_neck_support', {}).get('kaykit-medium-v1')
    if neck_settings:
        neck_support_evidence['kaykit-medium-v1'] = neck_fit_module.add_body_neck_support(objects['body_torso'], rig, neck_settings)
    body_parts = [obj for name, obj in objects.items() if name.startswith('body_')]
    for name, obj in objects.items():
        if name.startswith('body_'):
            obj.name = name
    body_model = finish(items, body_parts, 'human-body-v1', meta)
    defaults = config['human_default_wearables']
    underwear_spec = importlib.util.spec_from_file_location(
        'modular_underwear', ROOT / 'scripts/modular-character-underwear.py',
    )
    underwear = importlib.util.module_from_spec(underwear_spec)
    underwear_spec.loader.exec_module(underwear)
    torso = objects['body_torso']
    tank = underwear.garment('upper_human_tank', rig, [torso, objects['body_arms']], defaults['upper'])
    briefs = underwear.garment(
        'lower_human_briefs', rig, [torso, objects['body_legs']], defaults['lower'],
        seam=config['human_waist_fit']['seam_height'],
    )
    default_clothes = [
        item(defaults[slot]['key'], defaults[slot]['name'], slot, [mesh], 'canonical', meta)
        for slot, mesh in [('upper', tank), ('lower', briefs)]
    ]
    finish(default_clothes, [], 'human-underwear-v1', meta)
    human = copy.deepcopy(base)
    human.update(name=config['labels']['human'], model_asset_key=body_model, model_url='/api/v1/assets/' + body_model, fixed_nodes=['body_hands'], body_regions={region: ['body_' + region] for region in ['head', 'scalp', 'torso', 'arms', 'legs', 'feet']})
    human_face_key = 'face-human-default-v1'
    if smile_source:
        # 新形象独立导出，已审核的身体、发型和服装继续使用原资源。
        face_head.name = '_canonical_face_head'
        face_scalp.name = '_canonical_face_scalp'
        declaration = next(source for source in config['sources'] if source['key'] == smile_source)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / declaration['normalized_model']))
        source_head = {obj.name.split('.')[0]: obj for obj in set(bpy.data.objects) - before if obj.type == 'MESH'}
        face_head = select(source_head['body_head'], 'face_head', lambda face, layer: True)
        face_scalp = select(source_head['body_scalp'], 'face_scalp', lambda face, layer: True)
        brow_indices = smile_module.brow_faces(source_head['hair_provider'], connected_faces)
        brows = select(source_head['hair_provider'], 'face_brows', lambda face, layer: face.index in brow_indices)
        face_head, face_scalp, smile_completion = smile_module.reshape(face_head, face_scalp, connected_faces, bind, brows=brows)
        smile_completion['source'] = smile_source
        face_completions.append(smile_completion)
        human_face_key = 'face-' + smile_source
        face_meta = {field: declaration['asset'][field] for field in ['source_url', 'license', 'provider', 'pack_key']}
        smile = item(human_face_key, config['names'][smile_source]['face'], 'face', [face_head, face_scalp, brows], smile_source, face_meta, ['head', 'scalp', 'ranger_original_features'], regions={'brows': [brows], 'smile_scalp': [face_scalp]})
        finish([smile], [], 'smile-head-v1', face_meta)
    human['defaults'] = dict(face=human_face_key, head='head-none-v1', upper=defaults['upper']['key'], lower=defaults['lower']['key'], shoes='shoes-none-v1', back='back-none-v1')
    default_head = smile['_objects'] if smile_source else [face_head, face_scalp]
    thumb = render([objects['body_hands'], objects['body_torso'], objects['body_arms'], objects['body_legs'], objects['body_feet'], *default_head, tank, briefs], 'human-thumbnail-v1', meta, human['name'], 'character')
    human.update(thumbnail_asset_key=thumb, thumbnail_url='/api/v1/assets/' + thumb)
    assets.append({**meta, 'key': thumb, 'name': human['name'], 'kind': 'character', 'url': human['thumbnail_url'], 'format': 'png'})
    body_definitions.append(human)

    # 分离每个职业，背部用原始独立节点在相同rest矩阵下取出。
    skeleton_report = None
    for source in config['sources']:
        key, spec = source['key'], source['spec']
        objects = load(source['normalized_model'])
        meta = {field: source['asset'][field] for field in ['source_url', 'license', 'provider', 'pack_key']}
        items = []
        face_head = select(objects['body_head'], 'face_head', lambda f, uv: True)
        face_scalp = select(objects['body_scalp'], 'face_scalp', lambda f, uv: True)
        if source.get('complete_face_from_canonical'):
            # 原脸以胡须代替嘴和下颌；保留独立五官，复用完整脸壳及其匹配头皮。
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(ROOT / config['canonical_input']['path']))
            reference = {obj.name: obj for obj in set(bpy.data.objects) - before if obj.type == 'MESH'}
            source_shell = max(connected_faces(face_head), key=len)
            reference_shell = max(connected_faces(reference['body_head']), key=len)
            features = select(face_head, 'face_features', lambda face, layer: face.index not in source_shell)
            shell = select(reference['body_head'], 'face_shell', lambda face, layer: face.index in reference_shell)
            retained_feature_faces = len(features.data.polygons)
            bind(shell, 'head')
            face_head = join([features, shell], 'face_head')
            face_scalp = select(reference['body_scalp'], 'face_scalp_complete', lambda face, layer: True)
            bind(face_scalp, 'head')
            face_completions.append({'source': key, 'method': 'canonical-shell-with-source-features', 'retained_feature_faces': retained_feature_faces, 'reference_shell_faces': len(reference_shell), 'reference_sha256': config['canonical_input']['sha256']})
        # 兜帽从固定脸壳取回后再计算指纹，避免去重仍使用拆分前的脸型。
        hood = None
        if key.endswith('rogue-hooded'):
            def is_hood(face, layer):
                uv = sum((loop[layer].uv for loop in face.loops), Vector((0, 0))) / len(face.loops)
                return uv.x < 0.125 and uv.y < 0.75
            hood = select(face_head, 'hood_part', is_hood)
            face_head = select(face_head, 'face_head_clean', lambda face, layer: not is_hood(face, layer))
        face_key = 'face-' + key
        default_face_key = 'face-skeleton-default-v1' if key == 'kaykit-skeletons-minion' else face_key
        deliver_face = key != smile_source and (face_order is None or default_face_key in face_order)
        # 共享 GLB 的旧网格保留原字节。目录和缩略图只发布当前选中的形象。
        face_covers = ['head', 'scalp']
        if smile_source:
            face_covers.append('ranger_smile_beard')
        items.append(item(face_key, config['names'][key]['face'], 'face', [face_head, face_scalp], key, meta, face_covers, deliver=deliver_face))
        smile_beard = None
        if 'hair_provider' in objects:
            hair = objects['hair_provider']
            if key == smile_source:
                # 短发共用，胡须随脸型选取。骷髅仍使用原有位置。
                beard_faces = smile_module.beard_faces(hair, connected_faces)
                original_faces = beard_faces | smile_module.brow_faces(hair, connected_faces)
                head = select(hair, 'head_provider', lambda face, layer: face.index not in original_faces)
                original_features = select(hair, 'ranger_original_features', lambda face, layer: face.index in original_faces)
                smile_beard = select(hair, 'ranger_smile_beard', lambda face, layer: face.index in beard_faces)
                smile_completion['fitted_beard_vertices'] = smile_module.fit_beard(smile_beard, face_head, connected_faces)
                head_parts = [head, original_features, smile_beard]
                head_regions = {'ranger_original_features': [original_features], 'ranger_smile_beard': [smile_beard]}
            else:
                excluded_regions = spec['hair_uv_regions'] if source.get('omit_source_head_hair') else ()

                def keep_headwear(face, layer):
                    if not excluded_regions:
                        return True
                    # 标准化头饰已合并原帽和源脸的附属网格；沿用当初拆分源脸的 UV 区域。
                    uv = sum((loop[layer].uv for loop in face.loops), Vector((0, 0))) / len(face.loops)
                    return not in_uv_regions(uv, excluded_regions)

                head = select(hair, 'head_provider', keep_headwear)
                helmet_settings = helmet_opening.get(key + '-head')
                if helmet_settings:
                    moved = helmet_module.fit_helmet_opening(head, helmet_settings, connected_faces)
                    head_fit_evidence.append({'wearable_key': key + '-head', 'node': head.name, 'settings': helmet_settings, 'moved_vertices': moved})
                if hood is not None:
                    head = join([head, hood], 'head_provider')
                head_parts = [head]
                head_regions = None
            items.append(item(key + '-head', config['names'][key]['head'], 'head', head_parts, key, meta, config['wearable_covers'][key + '-head'], regions=head_regions))
        upper = objects.get('upper_native', objects['upper_provider'])
        back_parts = []
        if spec.get('upper_nodes'):
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(ROOT / source['source']))
            imported = set(bpy.data.objects) - before
            source_rig = next((obj for obj in imported if obj.type == 'ARMATURE'), None)
            if source_rig:
                source_rig.animation_data_clear()
                source_rig.data.pose_position = 'REST'
                raw = {obj.name.split('.')[0]: obj for obj in imported if obj.type == 'MESH'}
                for name in spec['upper_nodes']:
                    part = raw[name]
                    if not part.vertex_groups:
                        part.vertex_groups.new(name='chest').add(list(range(len(part.data.vertices))), 1, 'REPLACE')
                    transforms = {group.index: rig.matrix_world.inverted() @ (rig.matrix_world @ rig.data.bones[group.name].matrix_local) @ (source_rig.matrix_world @ source_rig.data.bones[group.name].matrix_local).inverted() @ part.matrix_world for group in part.vertex_groups}
                    for vertex in part.data.vertices:
                        original = vertex.co.copy()
                        total = sum(group.weight for group in vertex.groups)
                        vertex.co = sum(((transforms[group.group] @ original) * (group.weight / total) for group in vertex.groups), Vector((0, 0, 0)))
                    part.parent = rig
                    part.parent_type = 'OBJECT'
                    part.matrix_parent_inverse = Matrix.Identity(4)
                    part.matrix_basis = Matrix.Identity(4)
                    for modifier in part.modifiers:
                        if modifier.type == 'ARMATURE':
                            modifier.object = rig
                    if not any(mod.type == 'ARMATURE' for mod in part.modifiers):
                        part.modifiers.new('Rig', 'ARMATURE').object = rig
                    back_parts.append((name, part))
            else:
                module_spec = importlib.util.spec_from_file_location('modular_binding', ROOT / 'scripts/provider-character-binding.py')
                binding = importlib.util.module_from_spec(module_spec)
                module_spec.loader.exec_module(binding)
                parts, fitted, _ = binding.bind_parts(bpy, bmesh, rig, imported, spec, objects)
                back_parts = list(zip(spec['upper_nodes'], [parts[name] for name in fitted['upper_nodes']]))
        excluded_triangles = set()
        for name, part in back_parts:
            part.data.calc_loop_triangles()
            for triangle in part.data.loop_triangles:
                excluded_triangles.add(tuple(sorted(tuple(round(c, 4) for c in part.data.vertices[index].co) for index in triangle.vertices)))
            suffix = name.split('_')[-1].lower()
            part.name = 'back_' + suffix
            items.append(item(key + '-back-' + suffix, config['names'][key]['back'][suffix], 'back', [part], key, meta))
        # 原上装已经三角化，删除与独立背部同位置的真实三角面。
        upper_only = select(upper, 'upper_outfit', lambda face, uv: tuple(sorted(tuple(round(c, 4) for c in vertex.co) for vertex in face.verts)) not in excluded_triangles)
        lower = objects.get('lower_native') if 'lower' in spec.get('default_wearables', {}) else objects.get('lower_provider')
        if key in mage_waist:
            lower = select(lower, 'mage_lower_waist', lambda f, uv: True)
            fitted = mage_module.split_mage_waist(
                upper_only, lower, mage_waist[key], garment_waist['height'], garment_waist['weights'],
            )
            mage_waist_evidence.append({'source': key, **fitted})
        for slot, original in [('upper', upper_only), ('lower', lower), ('shoes', objects.get('shoes_provider'))]:
            if original is None or slot in source.get('excluded_slots', []):
                continue
            excluded_uv = source.get('garment_excluded_uv', {}).get(slot, ())
            garment = anatomical(original, key, False, slot + '_outfit', excluded_uv)
            if garment.data.polygons:
                removed_faces = len(original.data.polygons) - len(garment.data.polygons)
                removed_body_faces = len(anatomical(original, key, True, '_body_source').data.polygons) if excluded_uv else removed_faces
                garment_key = 'skeleton-minion-lower-v1' if key == 'kaykit-skeletons-minion' and slot == 'lower' else key + '-' + slot
                pieces = [garment]
                hands = None
                if slot == 'upper':
                    wrist = min(abs(vertex.co.x) for vertex in objects['body_hands'].data.vertices)
                    hands = hand_clothing(objects['body_hands'], key, 'upper_hands', wrist, source.get('hand_body_uv_regions', []))
                    if hands is not None:
                        open_wrist(garment, wrist)
                        pieces.append(hands)
                entry = item(garment_key, config['names'][key][slot], slot, pieces, key, meta, config['wearable_covers'][garment_key] if slot == 'shoes' else [], hand_objects=[hands] if hands is not None else ())
                items.append(entry)
                evidence.append({'wearable_key': garment_key, 'slot': slot, 'native': slot + '_native' in objects, 'removed_body_faces': removed_body_faces, 'remaining_body_faces': len(anatomical(garment, key, True, '_body_check').data.polygons), 'hand_faces': len(hands.data.polygons) if hands is not None else 0})
                if excluded_uv:
                    evidence[-1]['removed_cap_faces'] = removed_faces - removed_body_faces
        # 新版侍从提供真实肋骨和四肢；缺失的髋部与大腿根在同一骨架离线补齐。
        extra = []
        if key == 'kaykit-skeletons-minion':
            torso_arms = anatomical(upper_only, key, True, 'skeleton_upper_bones')
            legs = anatomical(objects['lower_provider'], key, True, 'body_legs')
            feet = anatomical(objects['shoes_provider'], key, True, 'body_feet')
            hands = select(objects['body_hands'], 'body_hands', lambda f, uv: True)
            torso = select(torso_arms, 'body_torso', lambda face, uv: abs(face.calc_center_median().x) < .33)
            arms = select(torso_arms, 'body_arms', lambda face, uv: abs(face.calc_center_median().x) >= .33)
            bone_mat = bpy.data.materials.new('Skeleton_Bone')
            bone_mat.diffuse_color = (.76, .61, .41, 1)
            bone_mat.use_nodes = True
            bone_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (.76, .61, .41, 1)
            source_bone_faces = sum(len(obj.data.polygons) for obj in [torso_arms, legs, feet, hands])
            additions = []
            # 源短裤替代了髋部和大腿根，用低面数骨骼连接保留已有腿骨与骨盆。
            for side in [-1, 1]:
                bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=4, location=(side * .16, 0, .67))
                pelvis = bpy.context.object
                pelvis.scale = (.13, .09, .12)
                bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
                pelvis.data.materials.append(bone_mat)
                bind(pelvis, 'hips')
                additions.append(pelvis)
                bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=.055, depth=.24, location=(side * .17, 0, .50))
                thigh = bpy.context.object
                thigh.data.materials.append(bone_mat)
                bind(thigh, 'upperleg.l' if side > 0 else 'upperleg.r')
                additions.append(thigh)
            augmentation_faces = sum(len(obj.data.polygons) for obj in additions)
            legs = join([legs, *additions], 'body_legs')
            knee_report = []
            if config.get('skeleton_knee_fit'):
                # 配方显式启用时才延长新增大腿，归档旧配方不自动获得新网格。
                knee_spec = importlib.util.spec_from_file_location('modular_skeleton_knee', ROOT / 'scripts/modular-character-skeleton-knee.py')
                knee_module = importlib.util.module_from_spec(knee_spec)
                knee_spec.loader.exec_module(knee_module)
                knee_report = knee_module.close_skeleton_knees(legs, rig, **config['skeleton_knee_fit'])
            hip_report = []
            if config.get('skeleton_hip_fit'):
                # 新增股骨上环跟随髋球；源腿骨和原骨架不承担这项修补。
                hip_spec = importlib.util.spec_from_file_location('modular_skeleton_hip', ROOT / 'scripts/modular-character-skeleton-hip.py')
                hip_module = importlib.util.module_from_spec(hip_spec)
                hip_spec.loader.exec_module(hip_module)
                hip_report = hip_module.bind_skeleton_hip_joints(legs, rig, config['skeleton_hip_fit'])
            waist_report = None
            if config.get('skeleton_waist_fit'):
                waist_report = waist_fit_module.fit_skeleton_waist([torso, legs, arms], rig, config['skeleton_waist_fit'])
            neck_settings = config.get('body_neck_support', {}).get('kaykit-skeleton-v1')
            if neck_settings:
                neck_support_evidence['kaykit-skeleton-v1'] = neck_fit_module.add_body_neck_support(torso, rig, neck_settings)
            extra = [torso, arms, legs, feet, hands]
            if clothing_module is not None and hand_surface is not None:
                # 腕部接合兼容本批次的实际皮肤和骨体，不猜测整节点的绑定。
                hand_surface['skeleton_hand_surface'] = clothing_module.capture_hand_surface(hands)
                hand_surface['skeleton_arm_surface'] = clothing_module.capture_hand_surface(arms)
            skeleton_report = {'source': key, 'source_bone_faces': source_bone_faces, 'augmentation_faces': augmentation_faces, 'completed_regions': ['pelvis', 'upper_thighs'], 'knee_connection': knee_report, 'hip_connection': hip_report, 'waist_fit': waist_report, 'method': 'Source bone UV surfaces retained; pelvis and upper-thigh joints completed offline on the shared rig.'}
        if not any(entry and entry['_deliver'] for entry in items) and not extra:
            continue
        model_key = finish(items, extra, key, meta, thumbnail_omit=smile_beard)
        if extra:
            skeleton = copy.deepcopy(human)
            skeleton.update(character_key='kaykit-skeleton-v1', name=config['labels']['skeleton'], model_asset_key=model_key, model_url='/api/v1/assets/' + model_key, pack_key='kaykit-skeletons')
            skeleton['body_regions']['head'] = []
            skeleton['body_regions']['scalp'] = []
            skeleton['defaults'] = dict(face='face-skeleton-default-v1', head='head-none-v1', upper='upper-none-v1', lower='skeleton-minion-lower-v1', shoes='shoes-none-v1', back='back-none-v1')
            face_item = items[0]
            if face_item:
                aliases[face_item['wearable_key']] = 'face-skeleton-default-v1'
                face_item['wearable_key'] = 'face-skeleton-default-v1'
            lower_item = next(entry for entry in items if entry and entry['slot'] == 'lower')
            thumb = render([*extra, *face_item['_objects'], *lower_item['_objects']], 'skeleton-thumbnail-v1', meta, skeleton['name'], 'character')
            skeleton.update(thumbnail_asset_key=thumb, thumbnail_url='/api/v1/assets/' + thumb)
            assets.append({**meta, 'key': thumb, 'name': skeleton['name'], 'kind': 'character', 'url': skeleton['thumbnail_url'], 'format': 'png'})
            body_definitions.append(skeleton)
        print('MODULAR_SOURCE', key, len([entry for entry in items if entry]), flush=True)

    # 中箭复用来源独立箭模型，只绑头骨，不混入破脸或其他身体战损。
    objects = load(config['canonical_input']['path'])
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / config['arrow_input']['path']))
    imported = [obj for obj in set(bpy.data.objects) - before if obj.type == 'MESH']
    arrow = join(imported, 'head_arrow')
    coords = [arrow.matrix_world @ vertex.co for vertex in arrow.data.vertices]
    center = Vector(tuple((min(v[i] for v in coords) + max(v[i] for v in coords)) / 2 for i in range(3)))
    longest = max(range(3), key=lambda i: max(v[i] for v in coords) - min(v[i] for v in coords))
    direction = Vector((1, .25, .15)).normalized()
    axis = Vector(tuple(1 if i == longest else 0 for i in range(3)))
    rotation = axis.rotation_difference(direction)
    length = max(v[longest] for v in coords) - min(v[longest] for v in coords)
    for vertex in arrow.data.vertices:
        vertex.co = rotation @ ((arrow.matrix_world @ vertex.co - center) * (.9 / length)) + Vector((.18, -.04, 1.85))
    arrow.matrix_world = Matrix.Identity(4)
    bind(arrow, 'head')
    meta = {key: config['arrow_asset'][key] for key in ['source_url', 'license', 'provider', 'pack_key']}
    arrow_item = item('head-arrow-v1', config['labels']['arrow'], 'head', [arrow], 'independent-arrow', meta, config['wearable_covers']['head-arrow-v1'])
    finish([arrow_item], [], 'head-arrow-v1', meta)

    # 空穿戴使用真实默认身体图，不伪造商品。无上装和无鞋仅骷髅默认免费。
    for slot in ['head', 'back', 'upper', 'shoes']:
        name = config['labels']['none_' + slot]
        wearables.append(dict(wearable_key=slot + '-none-v1', name=name, slot=slot, character_key='kaykit-medium-v1', body_key=config['body_key'], rig_key=config['rig_key'], provider='kaykit', pack_key='adventurers', model_asset_key=human['model_asset_key'], model_url=human['model_url'], thumbnail_asset_key=human['thumbnail_asset_key'], thumbnail_url=human['thumbnail_url'], nodes=[], covers=[], empty=True))
    for entry in produced:
        entry.pop('_objects', None)
        entry.pop('_source', None)
        entry.pop('_metadata', None)
        entry.pop('_deliver', None)
        entry.pop('_regions', None)
        wearables.append(entry)
    if face_order is not None:
        by_key = {entry['wearable_key']: entry for entry in wearables if entry['slot'] == 'face'}
        faces = [by_key[key] for key in face_order]
        wearables = faces + [entry for entry in wearables if entry['slot'] != 'face']
    for definition in body_definitions:
        definition['defaults'] = {slot: aliases.get(key, key) for slot, key in definition['defaults'].items()}
    default_keys = {key for definition in body_definitions for key in definition['defaults'].values()}
    offers = [dict(wearable_key=entry['wearable_key'], name=entry['name'], coin_price=config['prices'][entry['slot']], diamond_price=0) for entry in wearables if not entry.get('empty') and entry['wearable_key'] not in default_keys]
    catalog = {'characters': body_definitions, 'wearables': wearables}
    previous_assets = json.loads((BUILTIN / 'catalog.json').read_text())
    previous_manifest_path = ROOT / 'internal/assets/provider-character-manifest.json'
    old_manifest = json.loads(previous_manifest_path.read_text())
    old_character_asset_keys = {entry['key'] for entry in old_manifest.get('assets', [])}
    retained = [entry for entry in previous_assets if entry['key'] not in old_character_asset_keys and not (entry.get('provider') == 'kenney' and entry['kind'] in ['character', 'wearable']) and not (entry.get('kind') == 'wearable')]
    dedup_assets = {entry['key']: entry for entry in retained + assets}
    manifest = {'recipe': config['recipe'], 'body_key': config['body_key'], 'characters': [{'definition': entry, 'provider': 'kaykit', 'status': 'imported'} for entry in body_definitions], 'sources': [{key: value for key, value in entry.items() if key not in ['asset', 'spec']} for entry in config['sources']], 'assets': assets, 'wearable_evidence': evidence, 'face_completions': face_completions, 'human_body': human_body_evidence, 'clothing_fit_evidence': clothing_fit_evidence, 'back_fit_evidence': back_fit_evidence, 'neck_support_evidence': neck_support_evidence, 'head_fit_evidence': head_fit_evidence, 'human_waist_evidence': human_waist_evidence, 'skeleton_body': skeleton_report, 'aliases': aliases, 'processing_complete': True, 'validation_status': 'not_run', 'failures': [], 'verified_inputs': verified_inputs, 'archive_verification': 'Archive checksums are retained source records; archive bytes were not rehashed in this run.'}
    if mage_waist_evidence:
        manifest['mage_waist_evidence'] = mage_waist_evidence
    updates = {ROOT / 'internal/character/character-catalog.json': catalog, ROOT / 'internal/shop/wearable-products.json': offers, BUILTIN / 'catalog.json': list(dedup_assets.values()), previous_manifest_path: manifest}
    write_candidate(staging, output, {path: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode() for path, value in updates.items()}, retained, ROOT, baseline, dependencies)
    print('人物候选生成完成', len(body_definitions), len(wearables), len(offers), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'.local/asset-pipeline/characters')
    parser.add_argument('--recipe', type=Path, default=CONFIG)
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    prepare(parser.parse_args(arguments))
