"""只在独立 Blender 进程生成多视角 PNG；不保存工程或改写源模型。"""
import argparse
import json
import math
from pathlib import Path
import struct
import sys

CONTENT = json.loads(Path(__file__).with_name('render-gltf-previews-content.json').read_text())
# glTF 的 +Z 正面在导入 Blender 后对应 -Y，所有视角使用相同垂直方向。
VIEW_DIRECTIONS = {'front': (0, -1, 0), 'right': (1, 0, 0), 'back': (0, 1, 0), 'left': (-1, 0, 0)}


# Blender 会自动读取外链文件，因此在导入前明确限制为交付用的自包含 GLB。
def check_self_contained(model):
    data = model.read_bytes()
    if model.suffix.lower() != '.glb' or len(data) < 20:
        raise ValueError(CONTENT['invalid_glb'])
    magic, version, total = struct.unpack_from('<III', data)
    length, chunk_type = struct.unpack_from('<II', data, 12)
    if magic != 0x46546C67 or version != 2 or total != len(data) or chunk_type != 0x4E4F534A or 20 + length > len(data):
        raise ValueError(CONTENT['invalid_glb'])
    document = json.loads(data[20:20 + length])
    for entry in document.get('buffers', []) + document.get('images', []):
        if 'uri' in entry and not entry['uri'].startswith('data:'):
            raise ValueError(CONTENT['external_resource'])


# 最终设置完整写入报告，供调用方记录和计算缓存指纹。
def render_settings(overrides):
    settings = {**CONTENT['defaults'], **overrides}
    views = settings['views']
    if (not isinstance(settings['size'], int) or isinstance(settings['size'], bool) or settings['size'] < 1
            or not views or any(view not in VIEW_DIRECTIONS for view in views) or len(set(views)) != len(views)
            or not math.isfinite(settings['padding']) or settings['padding'] < 1
            or not math.isfinite(settings['elevation']) or abs(settings['elevation']) > 1 or settings['pose'] != 'rest'):
        raise ValueError(CONTENT['invalid_settings'])
    return settings


# 同一模型所有视角共享镜头比例和灯光，角度切换不能改变物件尺度。
def render_model(job, settings):
    import bpy
    from mathutils import Vector

    model = Path(job['model']).resolve()
    check_self_contained(model)
    output = Path(job['output_directory']).resolve()
    files = [output / (view + '.png') for view in settings['views']]
    if model in [path.resolve() for path in files]:
        raise ValueError(CONTENT['input_output_conflict'])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    scale = job.get('scale', 1)
    if not isinstance(scale, (int, float)) or isinstance(scale, bool) or not math.isfinite(scale) or scale <= 0:
        raise ValueError(CONTENT['invalid_scale'])
    visible_nodes = job.get('visible_nodes')
    if visible_nodes is not None:
        meshes_by_name = {obj.name: obj for obj in bpy.context.scene.objects if obj.type == 'MESH'}
        missing = set(visible_nodes) - meshes_by_name.keys()
        if missing:
            raise ValueError(CONTENT['missing_nodes'].format(nodes=', '.join(sorted(missing))))
        for name, obj in meshes_by_name.items():
            obj.hide_render = name not in visible_nodes
    for obj in bpy.context.scene.objects:
        obj.animation_data_clear()
        if obj.type == 'ARMATURE':
            obj.data.pose_position = 'REST'
        if obj.parent is None:
            # 只缩放导入场景的根对象，子网格随父级变化，避免重复施加比例。
            obj.scale *= scale
            obj.location *= scale
    bpy.context.view_layer.update()
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and not obj.hide_render]
    if not meshes:
        raise ValueError(CONTENT['no_geometry'])
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    lower = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    upper = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    center = (lower + upper) / 2
    extents = upper - lower
    if not all(math.isfinite(value) for value in [*lower, *upper]) or max(extents) <= 0:
        raise ValueError(CONTENT['invalid_bounds'])
    scene = bpy.context.scene
    engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
    scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = scene.render.resolution_y = settings['size']
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.world = bpy.data.worlds.new('GltfPreviewWorld')
    scene.world.color = (.6, .6, .6)
    scene.view_settings.view_transform = 'Standard'
    camera_data = bpy.data.cameras.new('GltfPreviewCamera')
    camera_data.type = 'ORTHO'
    camera = bpy.data.objects.new('GltfPreviewCamera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    # 半径包围盒让四个角度共用一种取景比例，并给抬高的镜头留下边距。
    span = max(extents.length, .001)
    camera_data.ortho_scale = span * settings['padding']
    camera_data.clip_start = max(span / 10000, .00001)
    camera_data.clip_end = span * 20
    for name, position, energy in [('Key', (4, -5, 7), 700), ('Fill', (-4, -1, 4), 400), ('Back', (1, 5, 5), 400)]:
        light_data = bpy.data.lights.new(name, 'AREA')
        light_data.energy = energy * span * span / 4
        light_data.shape = 'DISK'
        light_data.size = span * 2
        light = bpy.data.objects.new(name, light_data)
        scene.collection.objects.link(light)
        light.location = center + Vector(position) * span / 2
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    output.mkdir(parents=True, exist_ok=True)
    for view, path in zip(settings['views'], files):
        direction = Vector(VIEW_DIRECTIONS[view])
        direction.z = settings['elevation']
        camera.location = center + direction.normalized() * span * 3
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
    # glTF x/y/z 对应 Blender x/z/-y，报告仍使用源 GLB 的米制坐标。
    bounds = [[lower.x, upper.x], [lower.z, upper.z], [-upper.y, -lower.y]]
    return {'key': job['key'], 'status': 'rendered', 'files': [str(path) for path in files],
            'bounds_m': bounds, 'coordinate_system': 'glTF +Y up'}


# 每项独立失败并落盘进度，调用方可保留已完成项并重试失败项。
def run_jobs(path):
    batch = json.loads(path.read_text())
    settings = render_settings(batch.get('settings', {}))
    result_path = Path(batch['result_path']).resolve()
    protected = {path.resolve(), *(Path(job['model']).resolve() for job in batch['jobs'])}
    if result_path in protected:
        raise ValueError(CONTENT['input_output_conflict'])
    result_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'settings': settings, 'items': []}
    for job in batch['jobs']:
        try:
            result = render_model(job, settings)
            print('素材预览完成', job['key'], flush=True)
        except Exception as error:
            result = {'key': job['key'], 'status': 'failed', 'files': [], 'error': str(error)}
            print('素材预览失败', job['key'], str(error), flush=True)
        report['items'].append(result)
        temporary = result_path.with_suffix(result_path.suffix + '.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(result_path)
    if not report['items']:
        result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return 1 if any(item['status'] == 'failed' for item in report['items']) else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=CONTENT['description'])
    parser.add_argument('--jobs', required=True, type=Path, help=CONTENT['jobs_help'])
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    raise SystemExit(run_jobs(parser.parse_args(arguments).jobs))
