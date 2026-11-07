"""只读组装正式穿戴，生成逐件四向画面、动作对照和绑定模型哈希的证据。"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


# 候选缺少文件时只允许复用清单中同哈希的正式资源。
def asset_path(key, asset_directory=None, fallback_directory=None):
    formal = Path(fallback_directory or ROOT/'internal/assets/builtin')/(key + '.glb')
    if asset_directory is None:
        if formal.is_file():
            return formal
        raise FileNotFoundError('missing asset ' + key + ': ' + str(formal))
    candidate = Path(asset_directory)/(key + '.glb')
    if candidate.is_file():
        return candidate
    declaration = Path(asset_directory)/'reused-assets.json'
    reused = json.loads(declaration.read_text()) if declaration.is_file() else {}
    expected = reused.get(formal.name)
    if expected is None or not formal.is_file():
        raise FileNotFoundError('undeclared or missing candidate asset ' + key + ': ' + str(candidate) + ', ' + str(formal))
    if hashlib.sha256(formal.read_bytes()).hexdigest() != expected:
        raise ValueError('reused asset checksum mismatch: ' + key)
    return formal


# 在真正读取的边界记录哈希和路径，不能用目录里的预期哈希代替实际文件。
def read_asset_source(key, hashes, asset_directory=None, source_paths=None):
    path = asset_path(key, asset_directory)
    hashes[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    if source_paths is not None:
        source_paths[key] = str(path.resolve())
    return path


# 不购买或改写目录，逐件只替换对应槽；裸脸检查明确卸下头饰。
def build_scenarios(catalog, representatives, all_wearables=False, only=None, motions=None, faces=None):
    if all_wearables or only:
        wearables = [item for item in catalog['wearables'] if not item.get('empty')]
        requested = set(only or [])
        missing = requested - {item['wearable_key'] for item in wearables}
        if missing:
            raise ValueError('unknown wearable keys: ' + ', '.join(sorted(missing)))
        if requested:
            wearables = [item for item in wearables if item['wearable_key'] in requested]
        empty_head = next(item['wearable_key'] for item in catalog['wearables']
                          if item['slot'] == 'head' and item.get('empty'))
        scenarios = []
        for item in wearables:
            for body in catalog['characters']:
                if (item['body_key'], item['rig_key']) != (body['body_key'], body['rig_key']):
                    continue
                selection = {item['slot']: item['wearable_key']}
                if item['slot'] == 'face':
                    selection['head'] = empty_head
                scenarios.append({'key': body['character_key'] + '--' + item['wearable_key'],
                                  'name': body['name'] + ' · ' + item['name'],
                                  'body': body['character_key'], 'selection': selection,
                                  'wearable_key': item['wearable_key'], 'slot': item['slot']})
    else:
        scenarios = [dict(item) for item in representatives]
    if faces:
        requested_faces = dict.fromkeys(faces)
        available_faces = {item['wearable_key'] for item in catalog['wearables'] if item['slot'] == 'face'}
        missing = requested_faces.keys() - available_faces
        if missing:
            raise ValueError('unknown face keys: ' + ', '.join(sorted(missing)))
        if any(item.get('slot') != 'head' for item in scenarios):
            raise ValueError('face overrides require head wearable selections')
        scenarios = [{**item, 'key': item['key'] + '--' + face,
                      'selection': {**item['selection'], 'face': face}, 'face_key': face}
                     for item in scenarios for face in requested_faces]
    result = []
    for scenario in scenarios:
        result.append({**scenario, 'pose': 'rest'})
        for motion in dict.fromkeys(motions or []):
            result.append({**scenario, 'key': scenario['key'] + '--' + motion,
                           'name': scenario['name'] + ' · ' + motion, 'pose': motion})
    return result


# 全身检查只消费已实现的四向镜头，局部镜头仍由专项工具提供。
def read_sampling_plan(path):
    document = json.loads(Path(path).read_text())
    sampling = document.get('sampling', document)
    views = sampling.get('views', [])
    if not views or len(set(views)) != len(views) or any(view not in ['front', 'back', 'left', 'right'] for view in views):
        raise ValueError('unsupported sampling views')
    poses = sampling.get('poses', [])
    if not poses or any(not isinstance(item.get('motion'), str) or not item['motion'] or not isinstance(item.get('frame'), (int, float)) or isinstance(item['frame'], bool) or not math.isfinite(item['frame']) for item in poses):
        raise ValueError('invalid sampling poses')
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1 for value in sampling.get('motion_samples', [])):
        raise ValueError('invalid normalized motion sample')
    return sampling


# 每个姿势有独立输出身份，精确帧和比例时间不能混用。
def sampling_scenarios(scenarios, sampling):
    result = []
    for scenario in scenarios:
        samples = [{'pose': item['motion'], 'frame': item['frame']} for item in sampling['poses']]
        if scenario.get('slot') in ['body', 'upper', 'lower', 'shoes', 'back']:
            samples += [{'pose': motion, 'normalized_time': value} for motion in sampling.get('motions', []) for value in sampling.get('motion_samples', [])]
        for sample in samples:
            label = 'frame-' + str(sample['frame']) if 'frame' in sample else 'time-' + str(sample['normalized_time'])
            result.append({**scenario, **sample, 'key': scenario['key'] + '--' + sample['pose'] + '--' + label})
    return result


# 比例时间相对于实际动画范围计算，旧调用仍默认取35%。
def sample_frame(frame_range, sample):
    if 'frame' in sample:
        return sample['frame']
    start, end = frame_range
    return start + (end-start)*sample.get('normalized_time', .35)


# 覆盖标识只描述实际输出的视角与帧，不把局部镜头或人工结论填为通过。
def scenario_coverage(scenario, views):
    case = 'body:' + scenario['body'] if scenario.get('slot') == 'body' else ':'.join([scenario['body'], scenario.get('slot', 'representative'), scenario.get('wearable_key', scenario['key'])])
    if scenario.get('face_key'):
        case += ':face:' + scenario['face_key']
    time = 'frame:' + str(scenario['frame']) if 'frame' in scenario else 'time:' + str(scenario.get('normalized_time', .35))
    return [case + '@' + view + '@' + scenario['pose'] + '@' + time for view in views]


# 逐项写入真实完成状态；中间失败后仍保留后续素材的检查结果。
def run_scenarios(scenarios, output, render):
    output.mkdir(parents=True, exist_ok=True)
    reports = []
    report = {}
    for scenario in scenarios:
        try:
            result = render(scenario)
            print('穿戴检查完成', scenario['key'], flush=True)
        except Exception as error:
            result = {'status': 'failed', 'files': [], 'error': str(error)}
            print('穿戴检查失败', scenario['key'], str(error), flush=True)
        reports.append({**scenario, **result})
        summary = {status: sum(item['status'] == status for item in reports)
                   for status in ['rendered', 'failed']}
        report = {'items': reports, 'summary': summary,
                  'complete': len(reports) == len(scenarios) and not summary['failed'],
                  'visual_review': 'pending', 'validation_status': 'not_run'}
        temporary = output / 'evidence.json.tmp'
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(output / 'evidence.json')
    if not scenarios:
        raise ValueError('no compatible wearable scenarios')
    return report


# 动作从当前人物定义取得；静态快照只用于四向比较，不输出为正式穿戴。
def apply_motion(bpy, target, body, motion, hashes, asset_directory=None, source_paths=None, sample=None):
    definition = body['animations'][motion]
    path = read_asset_source(definition['asset_key'], hashes, asset_directory, source_paths)
    before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(path))
    actions = set(bpy.data.actions) - before
    action = next(action for action in actions
                  if action.name == definition['clip'] or action.name.partition('|')[-1] == definition['clip'])
    target.data.pose_position = 'POSE'
    target.animation_data_create()
    target.animation_data.action = action
    if action.slots:
        target.animation_data.action_slot = action.slots[0]
    frame = sample_frame(action.frame_range, sample or {})
    bpy.context.scene.frame_set(int(frame), subframe=frame % 1)
    bpy.context.view_layer.update()
    return {**definition, 'frame': frame}


# 只读取正式资源；组合 GLB 与画面始终写入独立的检查目录。
def load_appearance(scenario, bodies, wearables, asset_directory=None, source_paths=None):
    import bpy
    from mathutils import Matrix

    bpy.ops.wm.read_factory_settings(use_empty=True)
    body = bodies[scenario['body']]
    selection = {**body['defaults'], **scenario['selection']}
    outfit = [wearables[key] for key in selection.values()]
    source_keys = list(dict.fromkeys([body['model_asset_key'], *[item['model_asset_key'] for item in outfit if not item.get('empty')]]))
    sources = {}
    target = None
    hashes = {}
    for index, key in enumerate(source_keys):
        path = read_asset_source(key, hashes, asset_directory, source_paths)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path))
        added = set(bpy.data.objects) - before
        meshes = {obj.name: obj for obj in added if obj.type == 'MESH'}
        armature = next(obj for obj in added if obj.type == 'ARMATURE')
        armature.animation_data_clear()
        armature.data.pose_position = 'REST'
        if target is None:
            target = armature
        sources[key] = meshes
        # 对象身份保存在映射中，改名仅避免后续来源的 Blender 自动点号。
        for obj in added:
            obj.name = str(index) + '_' + obj.name
    covered = {region for item in outfit for region in item['covers']}
    base_names = [*body['fixed_nodes'], *[name for region, names in body['body_regions'].items() if region not in covered for name in names]]
    selected = [sources[body['model_asset_key']][name] for name in base_names]
    for item in outfit:
        other_covers = {region for other in outfit if other is not item for region in other['covers']}
        hidden = {name for region, names in item.get('regions', {}).items() if region in other_covers for name in names}
        for name in item['nodes']:
            if name not in hidden:
                selected.append(sources[item['model_asset_key']][name])
    selected = list(dict.fromkeys(selected))
    for obj in selected:
        matrix = obj.matrix_world.copy()
        obj.parent = target
        obj.parent_type = 'OBJECT'
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_world = matrix
        for modifier in obj.modifiers:
            if modifier.type == 'ARMATURE':
                modifier.object = target
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            obj.hide_render = obj not in selected
    return body, target, selected, hashes, selection, sources


# 四向检查与手臂近景复用同一正式组装，避免检查器各自解释 covers。
def render_scenario(scenario, bodies, wearables, output, renderer, settings, asset_directory=None):
    import bpy

    source_paths = {}
    body, target, selected, hashes, selection, _ = load_appearance(scenario, bodies, wearables, asset_directory, source_paths)
    animation = None
    if scenario['pose'] != 'rest':
        animation = apply_motion(bpy, target, body, scenario['pose'], hashes, asset_directory, source_paths, scenario)
    bpy.context.view_layer.update()
    dependency_graph = bpy.context.evaluated_depsgraph_get()
    # 取实际求值后的表面，避免蒙皮前的包围盒把取景拉远，也固定动作检查帧。
    snapshots = []
    for obj in selected:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dependency_graph))
        snapshot = bpy.data.objects.new(obj.name + '_snapshot', mesh)
        bpy.context.collection.objects.link(snapshot)
        snapshot.matrix_world = obj.matrix_world
        snapshots.append(snapshot)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in snapshots:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = snapshots[0]
    model = output / (scenario['key'] + '.glb')
    bpy.ops.export_scene.gltf(filepath=str(model), export_format='GLB', use_selection=True, export_animations=False, export_skins=False)
    job = {'key': scenario['key'], 'model': str(model), 'output_directory': str(output / scenario['key']), 'scale': body['scale']}
    result = renderer.render_model(job, settings)
    result.update(selection=selection, source_sha256=hashes, source_paths=source_paths, animation=animation,
                  coverage=scenario_coverage(scenario, settings['views']), visual_review='pending')
    return result


# 逐件场景由目录生成，不需要手工维护与正式物件数量相同的第二张清单。
def verify(options):
    import bpy

    catalog = json.loads(options.catalog.read_text())
    bodies = {item['character_key']: item for item in catalog['characters']}
    wearables = {item['wearable_key']: item for item in catalog['wearables']}
    representatives = json.loads((ROOT / 'scripts/modular-character-evidence.json').read_text())
    faces = [item['wearable_key'] for item in catalog['wearables'] if item['slot'] == 'face'] if options.all_faces else options.face
    sampling = read_sampling_plan(options.sampling_plan) if options.sampling_plan else None
    scenarios = build_scenarios(catalog, representatives, options.all_wearables, options.only, None if sampling else options.motion, faces)
    if sampling:
        if options.all_wearables:
            scenarios += [{'key': 'body--' + body['character_key'], 'body': body['character_key'], 'name': body['name'], 'selection': {}, 'slot': 'body', 'pose': 'rest'} for body in catalog['characters']]
        scenarios = sampling_scenarios(scenarios, sampling)
    spec = importlib.util.spec_from_file_location('modular_preview_renderer', ROOT / 'scripts/render-gltf-previews.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    settings = renderer.render_settings({'size': options.size, **({'views': sampling['views']} if sampling else {})})
    report = run_scenarios(scenarios, options.output,
                           lambda scenario: render_scenario(scenario, bodies, wearables, options.output, renderer, settings, options.asset_directory))
    report.update(settings=settings, sampling_plan=sampling,
                  sampling_sha256=hashlib.sha256(options.sampling_plan.read_bytes()).hexdigest() if options.sampling_plan else None,
                  executed_coverage=[case for item in report['items'] if item['status'] == 'rendered' for case in item.get('coverage', [])],
                  blender_version=bpy.app.version_string,
                  catalog_path=str(options.catalog.resolve()),
                  catalog_sha256=hashlib.sha256(options.catalog.read_bytes()).hexdigest(),
                  asset_directory=str(options.asset_directory.resolve()) if options.asset_directory else None,
                  pipeline_sha256={path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                   for path in [Path(__file__), ROOT / 'scripts/render-gltf-previews.py']})
    (options.output / 'evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return int(not report['complete'])


# 复用已有总览图布局，失败项也占一行，不会从视觉审查中消失。
def create_contact_sheets(options):
    spec = importlib.util.spec_from_file_location('modular_contact_sheets', ROOT / 'scripts/preview-gltf-assets.py')
    preview = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preview)
    path = options.output / 'evidence.json'
    report = json.loads(path.read_text())
    report['sheets'] = preview.contact_sheets(report['items'], options.output,
                                             SimpleNamespace(size=options.size, page_size=options.page_size, font=options.font))
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return int(not report['complete'])


# 普通 Python 管理 Pillow 总览图，Blender 子进程只负责实际模型和像素。
def main(arguments):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/modular-character-work/evidence')
    parser.add_argument('--catalog', type=Path, default=ROOT/'internal/character/character-catalog.json')
    parser.add_argument('--asset-directory', type=Path)
    parser.add_argument('--sampling-plan', type=Path)
    parser.add_argument('--all-wearables', action='store_true')
    parser.add_argument('--only', action='append')
    face_filter = parser.add_mutually_exclusive_group()
    face_filter.add_argument('--face', action='append')
    face_filter.add_argument('--all-faces', action='store_true')
    parser.add_argument('--motion', action='append', choices=['walk', 'cheer'])
    parser.add_argument('--size', type=int, default=256)
    parser.add_argument('--page-size', type=int, default=6)
    parser.add_argument('--font')
    parser.add_argument('--blender', default=os.environ.get('BLENDER_PATH', '/Applications/Blender.app/Contents/MacOS/Blender'))
    parser.add_argument('--render-only', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--sheets-only', action='store_true', help=argparse.SUPPRESS)
    options = parser.parse_args(arguments)
    options.output = options.output.resolve()
    if options.output.is_relative_to(ROOT / 'internal') or options.output.is_relative_to(ROOT / 'web/public'):
        parser.error('evidence output must stay outside production assets')
    if options.size < 1 or options.page_size < 1:
        parser.error('size and page-size must be positive')
    if options.sampling_plan and options.motion:
        parser.error('--motion cannot override --sampling-plan')
    if options.sampling_plan:
        read_sampling_plan(options.sampling_plan)
    if options.sheets_only:
        return create_contact_sheets(options)
    if importlib.util.find_spec('bpy') is None:
        result = subprocess.run([options.blender, '--background', '--factory-startup', '--python-exit-code', '1',
                                 '--python', str(Path(__file__).resolve()), '--', *arguments, '--render-only'], cwd=ROOT)
        if (options.output / 'evidence.json').exists():
            sheets_result = create_contact_sheets(options)
            return result.returncode or sheets_result
        return result.returncode
    result = verify(options)
    if not options.render_only:
        sheets = subprocess.run(['uv', 'run', '--locked', 'python', str(Path(__file__).resolve()),
                                  '--output', str(options.output), '--size', str(options.size),
                                  '--page-size', str(options.page_size), '--sheets-only',
                                  *(['--font', options.font] if options.font else [])], cwd=ROOT)
        return result or sheets.returncode
    return result


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    raise SystemExit(main(args))
