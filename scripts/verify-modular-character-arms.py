"""从正式 GLB 生成手臂、拳端或衣身近景；身体显隐仅用于诊断，不代表视觉验收通过。"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys

# Blender 执行脚本时不会把脚本目录加入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from character_catalog_source import load_character_catalog

ROOT = Path(__file__).resolve().parents[1]
POSES = [(item['motion'], item['frame']) for item in
         json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
ARM_BONES = ('upperarm', 'lowerarm', 'wrist', 'hand')


# 测试入口不导入 bpy，普通 Python 可以检查目录和镜头计算。
def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 所有非空上装来自实时目录；only 使用稳定 key，不能误把鞋当上装。
def build_cases(catalog, only=None):
    uppers = [item for item in catalog['wearables'] if item['slot'] == 'upper' and not item.get('empty')]
    missing = set(only or []) - {item['wearable_key'] for item in uppers}
    if missing:
        raise ValueError('unknown upper keys: ' + ', '.join(sorted(missing)))
    if only:
        uppers = [item for key in dict.fromkeys(only) for item in uppers if item['wearable_key'] == key]
    return [{'key': body['character_key'] + '--' + item['wearable_key'],
             'name': body['name'] + ' · ' + item['name'], 'body': body['character_key'],
             'wearable_key': item['wearable_key'], 'selection': {'upper': item['wearable_key']}}
            for item in uppers for body in catalog['characters']
            if (item['body_key'], item['rig_key']) == (body['body_key'], body['rig_key'])]


# 主图始终显示身体；静态诊断默认开启，其余帧由显式参数追加。
def visibility_modes(pose, compare_body):
    return [True, False] if pose == 'rest' or compare_body else [True]


# Blender 为已存在的动作追加数字后缀，资源身份仍由导入批次和目录 clip 决定。
def imported_action_matches(name, clip):
    name = name.rsplit('|', 1)[-1]
    return name == clip or (name.startswith(clip + '.') and name[len(clip)+1:].isdigit())


# 阅读时双臂移到胸前，背视会被真实胸甲挡住，改从同侧斜上方补看腕部。
def view_directions(pose, sign):
    second = ('outer-top', (sign*1.6, -.8, .55)) if pose == 'read' else ('back', (sign*.4, 1, .38))
    front = (sign*1.5, -1, .3) if pose == 'cheer' else (sign*.4, -1, .38)
    return [('front', front), second]


# 正交投影按单侧手臂点集取景，保留边距并记录实际投影轴以便复核。
def camera_frame(points, direction, minimum_span=.25):
    def normalized(vector):
        length = math.sqrt(sum(value * value for value in vector))
        return [value / length for value in vector]

    direction = normalized(direction)
    right = normalized([-direction[1], direction[0], 0] if math.hypot(*direction[:2]) > .001
                       else [direction[2], 0, -direction[0]])
    up = [direction[1]*right[2]-direction[2]*right[1],
          direction[2]*right[0]-direction[0]*right[2],
          direction[0]*right[1]-direction[1]*right[0]]
    bounds = [[min(sum(a*b for a, b in zip(point, axis)) for point in points),
               max(sum(a*b for a, b in zip(point, axis)) for point in points)]
              for axis in [right, up, direction]]
    target = [sum((lower+upper)/2*axis[i] for (lower, upper), axis in zip(bounds, [right, up, direction]))
              for i in range(3)]
    span = max(bounds[0][1]-bounds[0][0], bounds[1][1]-bounds[1][0], minimum_span) * 1.18
    return {'target': target, 'direction': direction, 'right': right, 'up': up, 'ortho_scale': span,
            'location': [a+b*3 for a, b in zip(target, direction)]}


# 完整胸背腰使用同一衣身范围，固定正后方避免动作时沿用单侧肩臂中心。
def torso_frames(points):
    return [(angle, camera_frame(points, direction))
            for angle, direction in [('front', (0,-1,0)), ('back', (0,1,0))]]


# 骨骼 head/tail 坐标属于骨架局部空间；两个端点都需先转世界坐标。
def hand_axis_world(head, tail, matrix):
    points = [[sum(matrix[row][column]*point[column] for column in range(3))+matrix[row][3]
               for row in range(3)] for point in [head, tail]]
    return {'head': points[0], 'tail': points[1], 'direction': [end-start for start, end in zip(*points)]}


# 动作使用目录中真实资源和精确帧；导入动作附带的可见网格全部隐藏。
def load_actions(bpy, body, hashes, asset_directory=None, source_paths=None, poses=None):
    assembly = load_module('arm_action_sources', 'verify-modular-character-appearance.py')
    actions = {}
    for asset_key in dict.fromkeys(body['animations'][pose]['asset_key'] for pose, _ in (poses or POSES) if pose != 'rest'):
        path = assembly.read_asset_source(asset_key, hashes, asset_directory, source_paths)
        old_actions, old_objects = set(bpy.data.actions), set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path))
        for obj in set(bpy.data.objects)-old_objects:
            obj.hide_render = True
        imported = set(bpy.data.actions)-old_actions
        for definition in body['animations'].values():
            if definition['asset_key'] == asset_key:
                actions[(asset_key, definition['clip'])] = next(action for action in imported
                                                               if imported_action_matches(action.name, definition['clip']))
    return actions


# 同一实际组装复用全部姿态；卸下动作时明确恢复 REST，而不是沿用上一帧。
def apply_pose(bpy, target, body, actions, pose, frame):
    target.animation_data_clear()
    target.data.pose_position = 'REST' if pose == 'rest' else 'POSE'
    definition = None
    if pose != 'rest':
        definition = body['animations'][pose]
        action = actions[(definition['asset_key'], definition['clip'])]
        target.animation_data_create()
        target.animation_data.action = action
        if action.slots:
            target.animation_data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(int(frame), subframe=frame % 1)
    bpy.context.view_layer.update()
    return definition


# 原始权重识别所需部位，位置取真实动作求值结果，不靠放大全身图片。
def weighted_points(bpy, objects, names):
    points = []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        indices = [vertex.index for vertex in obj.data.vertices
                   if sum(group.weight for group in vertex.groups if obj.vertex_groups[group.group].name in names) > .2]
        if not indices:
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ mesh.vertices[index].co for index in indices)
        evaluated.to_mesh_clear()
    return [list(point) for point in points]


# 肩侧交界留在手臂主图内；手套前端视角则仅取真实手部点集。
def arm_points(bpy, objects, target, side):
    from mathutils import Vector

    points = weighted_points(bpy, objects, {name + side for name in ARM_BONES})
    # 肩侧交界也必须留在图内，即使上装只在前臂有护具。
    bone = target.pose.bones['upperarm' + side]
    shoulder = target.matrix_world @ bone.head
    if target.data.pose_position == 'REST':
        shoulder = target.matrix_world @ target.data.bones['upperarm' + side].head_local
    points.extend(shoulder + Vector(offset) for offset in [(-.1, 0, 0), (.1, 0, 0), (0, -.12, -.12), (0, .12, .12)])
    if not points:
        raise ValueError('no actual arm points for ' + side)
    return [list(point) for point in points]


# 指端相机沿当前手骨轴看回拳端，保留真实身体和衣物几何参与遮挡。
def hand_end_frame(bpy, objects, target, side):
    bone = target.pose.bones['hand' + side]
    head, tail = bone.head, bone.tail
    if target.data.pose_position == 'REST':
        bone = target.data.bones['hand' + side]
        head, tail = bone.head_local, bone.tail_local
    axis = hand_axis_world(head, tail, target.matrix_world)
    points = weighted_points(bpy, objects, {'hand' + side})
    points.extend([axis['head'], axis['tail']])
    framing = camera_frame(points, axis['direction'], minimum_span=.12)
    framing['hand_axis_world'] = axis
    return framing


# torso仅按实际身体躯干与上装权重取景，不把头部或下装裙摆拉进镜头。
def torso_points(bpy, objects):
    names = {group.name for obj in objects for group in obj.vertex_groups
             if group.name.startswith(('hips', 'spine', 'chest'))}
    points = weighted_points(bpy, objects, names)
    if not points:
        raise ValueError('no evaluated hips/spine/chest torso points')
    return points


# 诊断仅改变基础身体对象；主图始终保留原有身体和衣物遮挡。
def diagnostic_objects(body, base, selected, view):
    if view == 'torso':
        names = [*body['fixed_nodes'], *[name for group in body['body_regions'].values() for name in group]]
    else:
        names = [*body['body_regions']['arms'], *[name for name in body['fixed_nodes'] if name == 'body_hands']]
    return list(dict.fromkeys(base[name] for name in names if name in base and base[name] in selected))


# 灯光沿用现有 GLB 预览的三个面光源；实际躯干与肩袖连接始终参与遮挡。
def setup_scene(bpy, size):
    from mathutils import Vector

    scene = bpy.context.scene
    engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
    scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.world = bpy.data.worlds.new('ArmReviewWorld')
    scene.world.color = (.6, .6, .6)
    scene.view_settings.view_transform = 'Standard'
    data = bpy.data.cameras.new('ArmReviewCamera')
    data.type = 'ORTHO'
    camera = bpy.data.objects.new('ArmReviewCamera', data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for name, position, energy in [('Key', (4, -5, 7), 700), ('Fill', (-4, -1, 4), 400), ('Back', (1, 5, 5), 400)]:
        light_data = bpy.data.lights.new(name, 'AREA')
        light_data.energy = energy / 4
        light_data.shape = 'DISK'
        light_data.size = 2
        light = bpy.data.objects.new(name, light_data)
        scene.collection.objects.link(light)
        light.location = Vector((0, 0, 1)) + Vector(position)/2
        light.rotation_euler = (Vector((0, 0, 1))-light.location).to_track_quat('-Z', 'Y').to_euler()
    return scene, camera


# 只映射已实现的主图镜头；诊断和整条手臂视图不冒充更细的局部标准。
def frame_coverage(case, frame):
    if not frame['body_visible']:
        return None
    if frame['view'] == 'hand-end':
        view = 'hand-end'
    elif frame['view'] == 'torso':
        view = 'torso-' + frame['angle']
    else:
        return None
    return ':'.join([case['body'], 'upper', case['wearable_key']]) + '@' + view + '@' + frame['pose'] + '@frame:' + str(frame['frame'])


# 一件上装与一种身体只导入一次，同一姿态复用相机渲染左右前后局部。
def render_case(case, catalog, options, assembly):
    import bpy
    from mathutils import Vector

    bodies = {item['character_key']: item for item in catalog['characters']}
    wearables = {item['wearable_key']: item for item in catalog['wearables']}
    source_paths = {}
    body, target, selected, hashes, selection, sources = assembly.load_appearance(case, bodies, wearables, options.asset_directory, source_paths)
    poses = [item for item in getattr(options, 'sampling_poses', POSES) if not options.pose or item[0]+':'+str(item[1]) in options.pose]
    actions = load_actions(bpy, body, hashes, options.asset_directory, source_paths, poses)
    base = sources[body['model_asset_key']]
    diagnostic = diagnostic_objects(body, base, selected, options.view)
    torso_objects = []
    if options.view == 'torso':
        upper = wearables[case['wearable_key']]
        torso_objects = [base[name] for name in body['body_regions']['torso'] if base[name] in selected]
        torso_objects.extend(sources[upper['model_asset_key']][name] for name in upper['nodes']
                             if sources[upper['model_asset_key']][name] in selected)
    scene, camera = setup_scene(bpy, options.size)
    directory = options.output / case['key']
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for pose, frame in poses:
        if options.pose and pose + ':' + str(frame) not in options.pose:
            continue
        animation = apply_pose(bpy, target, body, actions, pose, frame)
        for side, sign in ([('torso', 0)] if options.view == 'torso' else [('.l', 1), ('.r', -1)]):
            if options.view == 'torso':
                cameras = torso_frames(torso_points(bpy, torso_objects))
            elif options.view == 'hand-end':
                cameras = [('hand-end', hand_end_frame(bpy, selected, target, side))]
            else:
                points = arm_points(bpy, selected, target, side)
                cameras = [(angle, camera_frame(points, direction)) for angle, direction in view_directions(pose, sign)]
            for angle, framing in cameras:
                camera.location = Vector(framing['location'])
                camera.rotation_euler = (Vector(framing['target'])-camera.location).to_track_quat('-Z', 'Y').to_euler()
                camera.data.ortho_scale = framing['ortho_scale']
                camera.data.clip_start, camera.data.clip_end = .001, 20
                for visible in visibility_modes(pose, options.compare_body):
                    for obj in diagnostic:
                        obj.hide_render = not visible
                    filename = f'{pose}-{frame}--{side.removeprefix(".")}--{angle}--' + ('body' if visible else 'diagnostic') + '.png'
                    path = directory / filename
                    scene.render.filepath = str(path)
                    bpy.ops.render.render(write_still=True)
                    records.append({'pose': pose, 'frame': frame, 'animation': animation, 'side': side,
                                    'angle': angle, 'view': options.view, 'body_visible': visible, 'diagnostic_only': not visible,
                                    'camera': framing, 'file': str(path)})
                for obj in diagnostic:
                    obj.hide_render = False
        print('手臂局部姿态完成', case['key'], pose, frame, flush=True)
    coverage = sorted({value for record in records if (value := frame_coverage(case, record)) is not None})
    return {'status': 'rendered', 'coverage': coverage, 'selection': selection, 'source_sha256': hashes, 'source_paths': source_paths, 'frames': records,
            'files': [item['file'] for item in records], 'visual_review': 'pending',
            'assembled_nodes': [obj.name for obj in selected],
            'diagnostic_hidden_scope': 'all_base_body_nodes' if options.view=='torso' else 'base_arms_and_hands',
            'diagnostic_hidden_nodes': [obj.name for obj in diagnostic]}


# 渲染成功只表示像素已生成；人工结论由独立 visual-review.json 记录。
def verify(options):
    import bpy

    assembly = load_module('arm_appearance_assembly', 'verify-modular-character-appearance.py')
    catalog_path = options.catalog
    catalog = load_character_catalog(catalog_path)
    cases = build_cases(catalog, options.only)
    if options.body:
        cases = [case for case in cases if case['body'] in options.body]
    report = assembly.run_scenarios(cases, options.output, lambda case: render_case(case, catalog, options, assembly))
    report.update(size=options.size, view=options.view, poses=options.sampling_poses,
                  executed_coverage=[case for item in report['items'] if item['status'] == 'rendered' for case in item.get('coverage', [])],
                  sampling_sha256=hashlib.sha256(options.sampling_plan.read_bytes()).hexdigest() if options.sampling_plan else None, blender_version=bpy.app.version_string,
                  coordinate_system='Blender +Z up; imported glTF coordinates',
                  catalog_path=str(catalog_path.resolve()),
                  asset_directory=str(options.asset_directory.resolve()) if options.asset_directory else None,
                  catalog_sha256=hashlib.sha256(catalog_path.read_bytes()).hexdigest(), visual_review='pending',
                  pipeline_sha256={path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                   for path in [Path(__file__), ROOT/'scripts/verify-modular-character-appearance.py',
                                                ROOT/'scripts/character_catalog_source.py']})
    (options.output/'evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    return int(not report['complete'])


# 每页仅显示同一上装/身体/动作的四张局部主图；原始 PNG 保持真实分辨率。
def create_contact_sheets(output):
    from PIL import Image, ImageDraw

    path = output/'evidence.json'
    report = json.loads(path.read_text())
    sheets = []
    for item in report['items']:
        frames = item.get('frames', [])
        for pose, frame in report.get('poses', POSES):
            for visible in [True, False]:
                group = [record for record in frames if (record['pose'], record['frame'], record['body_visible']) == (pose, frame, visible)]
                if not group:
                    continue
                # 384px 仅用于索引，报告保留每张 768px 原图路径。
                sheet = Image.new('RGB', (800, 60+math.ceil(len(group)/2)*408), '#e5e7eb')
                draw = ImageDraw.Draw(sheet)
                draw.text((12, 8), item['key'] + '\n' + f'{pose}:{frame}  ' + ('BODY VISIBLE' if visible else 'DIAGNOSTIC ONLY'), fill='#111827')
                for index, record in enumerate(group):
                    image = Image.open(record['file']).convert('RGBA')
                    image.thumbnail((384, 384))
                    x, y = 8+(index%2)*400, 60+(index//2)*408
                    sheet.paste(image, (x, y), image)
                    draw.text((x, y+386), record['side']+' '+record['angle'], fill='#111827')
                destination = output/(item['key']+f'--{pose}-{frame}--'+('body' if visible else 'diagnostic')+'--sheet.jpg')
                sheet.save(destination, quality=94)
                sheets.append(str(destination))
    report['sheets'] = sheets
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')


# Blender 负责实际 GLB 与像素，普通 Python 负责 Pillow 索引图。
def main(arguments):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'.local/modular-character-work/arm-review-v4')
    parser.add_argument('--catalog', type=Path, default=ROOT/'internal/character/character-catalog.json')
    parser.add_argument('--asset-directory', type=Path)
    parser.add_argument('--sampling-plan', type=Path)
    parser.add_argument('--only', action='append')
    parser.add_argument('--body', action='append')
    parser.add_argument('--pose', action='append')
    parser.add_argument('--compare-body', action='store_true')
    parser.add_argument('--view', choices=['arm', 'hand-end', 'torso'], default='arm')
    parser.add_argument('--size', type=int, default=768)
    parser.add_argument('--blender', default=os.environ.get('BLENDER_PATH', '/Applications/Blender.app/Contents/MacOS/Blender'))
    parser.add_argument('--render-only', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--sheets-only', action='store_true', help=argparse.SUPPRESS)
    options = parser.parse_args(arguments)
    options.sampling_poses = POSES
    if options.sampling_plan:
        assembly = load_module('arm_sampling_plan', 'verify-modular-character-appearance.py')
        sampling = assembly.read_sampling_plan(options.sampling_plan)
        options.sampling_poses = [(item['motion'], item['frame']) for item in sampling['poses']]
    if set(options.pose or []) - {pose+':'+str(frame) for pose, frame in options.sampling_poses}:
        parser.error('--pose must select a frame from the sampling plan')
    if options.view in ['hand-end','torso'] and not options.only:
        parser.error(options.view + ' view requires explicit --only upper keys')
    options.output = options.output.resolve()
    if options.output.is_relative_to(ROOT/'internal') or options.output.is_relative_to(ROOT/'web/public'):
        parser.error('evidence output must stay outside production assets')
    if options.size < 1:
        parser.error('size must be positive')
    if options.sheets_only:
        create_contact_sheets(options.output)
        return 0
    if importlib.util.find_spec('bpy') is None:
        result = subprocess.run([options.blender, '--background', '--factory-startup', '--python-exit-code', '1',
                                 '--python', str(Path(__file__).resolve()), '--', *arguments, '--render-only'], cwd=ROOT)
        if (options.output/'evidence.json').exists():
            create_contact_sheets(options.output)
        return result.returncode
    return verify(options)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    raise SystemExit(main(args))
