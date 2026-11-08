"""编排离线制作与可追溯检查；运行本文件本身不会隐式加工素材。"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RULES = Path(__file__).with_name('asset-pipeline-rules.json')


# 哈希用于绑定实际字节，不以路径名代替产物身份。
def digest(data):
    return hashlib.sha256(data).hexdigest()


# JSON只在完整写入临时文件后替换，日志先于正式文件落盘。
def write_json(path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


# 同目录替换防止进程中断留下半个JSON或半个资源。
def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.pipeline-tmp')
    with temporary.open('wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


# 删除同样同步父目录，使已落盘日志能够恢复被强制中断的源码移动。
def remove_file(path):
    try:
        path.unlink()
    except FileNotFoundError:
        return
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


# 相对路径只允许落入本次根目录，拒绝符号链接逃逸。
def local_path(root, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('invalid relative path: ' + str(relative))
    result = (root / path).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError('path outside root: ' + str(relative))
    return result


# 制作类型由审核配置声明，不从商品名称或商品分类猜测。
def classify(item):
    kind = item.get('processing_type')
    if kind not in json.loads(RULES.read_text())['types']:
        raise ValueError('processing_type required: ' + str(kind))
    return kind


# 未执行的必需检查明确保留，防止空集合被解释为通过。
def summarize_checks(required, results):
    return {key: results.get(key, {'status': 'not_run'}) for key in required}


# 只有全部必需项通过才允许应用，已知问题不能覆盖失败。
def checks_passed(results):
    return bool(results) and all(item['status'] == 'passed' for item in results.values())


# 历史证据必须匹配候选及当前检查规则。
def validate_evidence(evidence, candidate_hash, rules_hash):
    if evidence.get('candidate_sha256') != candidate_hash or evidence.get('rules_sha256') != rules_hash:
        raise ValueError('stale candidate or rules evidence')


# 公共候选工具由所有生产入口复用。
def candidate_tools():
    spec = importlib.util.spec_from_file_location('asset_candidate', Path(__file__).with_name('asset-pipeline-candidate.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 检查清单同时绑定实际候选和加工依赖，复用文件也必须保持原字节。
def verify_candidate(root, output):
    output = candidate_tools().validate_candidate_output(root, output)
    manifest = json.loads((output/'candidate.json').read_text())
    generated = manifest.get('generated', [])
    if manifest.get('states', {}).get('processing') != 'passed':
        raise ValueError('candidate processing has not passed')
    if not generated:
        raise ValueError('empty candidate')
    seen = set()
    for group, directory in [('generated', output), ('reused', root), ('dependencies', root)]:
        for entry in manifest.get(group, []):
            path = Path(entry['path']) if group == 'dependencies' and Path(entry['path']).is_absolute() else local_path(directory, entry['path'])
            if not path.is_file() or digest(path.read_bytes()) != entry['sha256']:
                raise ValueError('candidate dependency changed: ' + entry['path'])
            if group == 'generated':
                if not entry['path'].startswith('internal/') or entry['path'] in seen:
                    raise ValueError('invalid generated path: ' + entry['path'])
                seen.add(entry['path'])
    actual = {path.relative_to(output).as_posix() for path in (output/'internal').rglob('*') if path.is_file() and path.name != 'reused-assets.json'}
    if actual != seen:
        raise ValueError('untracked candidate files')
    return manifest


# 合并后的注册表负责受控资源身份，候选优先，正式目录只读。
def asset_registry(root, output):
    candidate = output/'internal/assets/builtin/catalog.json'
    path = candidate if candidate.exists() else root/'internal/assets/builtin/catalog.json'
    entries = json.loads(path.read_text()) if path.exists() else []
    result = {}
    for entry in entries:
        if entry['key'] in result:
            raise ValueError('duplicate registered asset: ' + entry['key'])
        result[entry['key']] = entry
    return result


# 根据来源记录和槽位识别本地发型，稳定身份不能被其他来源复用。
def is_local_hairstyle(item):
    return item['slot'] == 'head' and item.get('provider') == 'local' and item.get('pack_key') == 'local-hairstyles'


# 发型只改变头部穿戴；几何检查覆盖每个兼容脸型，而非重复共用同一规格的身体。
def local_hairstyle_cases(root, output, generated):
    relative = 'internal/character/character-catalog.json'
    if relative not in generated or not (root/relative).is_file():
        raise ValueError('local hairstyle candidate requires both character catalogs')
    original = json.loads((root/relative).read_text())
    catalog = json.loads((output/relative).read_text())
    previous = {item['wearable_key']: item for item in original.pop('wearables')}
    wearables = catalog.pop('wearables')
    current = {item['wearable_key']: item for item in wearables}
    if len(current) != len(wearables):
        raise ValueError('duplicate wearable identity')
    if original != catalog or previous.keys() - current.keys():
        raise ValueError('local hairstyle candidate changes existing character definitions')
    generated_models = {name for name in generated if name.endswith('.glb')}
    model_keys = {Path(name).stem for name in generated_models}
    changed = [item for key, item in current.items()
               if previous.get(key) != item or item.get('model_asset_key') in model_keys]
    if not changed:
        raise ValueError('local hairstyle candidate has no changes')
    faces = [item for item in current.values() if item['slot'] == 'face']
    bodies = {(body['body_key'], body['rig_key']) for body in catalog['characters']}
    cases, models = {}, set()
    for item in changed:
        key = item['wearable_key']
        if not is_local_hairstyle(item) or item.get('empty') or not item.get('dye_material'):
            raise ValueError('not a local hairstyle: ' + key)
        if key in previous and not is_local_hairstyle(previous[key]):
            raise ValueError('local hairstyle replaces unrelated wearable: ' + key)
        standard = item['body_key'], item['rig_key']
        compatible = [face for face in faces if (face['body_key'], face['rig_key']) == standard]
        if standard not in bodies or not compatible:
            raise ValueError('local hairstyle has no compatible body and face: ' + key)
        models.add(f"internal/assets/builtin/{item['model_asset_key']}.glb")
        for face in compatible:
            cases[f"{face['wearable_key']}:head:{key}"] = {'type': 'wearable', 'slot': 'head'}
    if models != generated_models:
        raise ValueError('missing or unassigned local hairstyle model')
    return cases


# 每个案例有实际加工类型，混合管线不能把所有检查套给全部文件。
def coverage_plan(root, output, manifest, rules):
    pipeline = manifest['pipeline']
    if pipeline not in rules['pipelines']:
        raise ValueError('unknown candidate pipeline: ' + pipeline)
    kinds = rules['pipelines'][pipeline]['types']
    registry = asset_registry(root, output)
    generated = {entry['path'] for entry in manifest['generated']}
    local_hairstyles = pipeline == 'local-hairstyles'
    cases = local_hairstyle_cases(root, output, generated) if local_hairstyles else {}
    houses_path = output/'internal/assets/tiny-treats-manifest.json'
    houses = json.loads(houses_path.read_text()).get('houses', []) if houses_path.exists() else []
    house_models = {entry['model_url'].rsplit('/', 1)[1] for entry in houses}
    for path in sorted(generated):
        name = Path(path)
        if name.suffix == '.glb':
            if local_hairstyles:
                continue  # 已由发型及兼容脸型组合覆盖。
            asset = registry.get(name.stem, {})
            kind = asset.get('processing_type') or rules['asset_kind_types'].get(asset.get('kind'))
            if name.stem in house_models:
                kind = 'scene'
            if kind is None and len(kinds) == 1:
                kind = kinds[0]
            if kind is None and pipeline in ['resources', 'tiny-treats']:
                kind = 'static'
            if kind is None and pipeline == 'characters':
                continue  # 共享人物GLB由下面的身体及穿戴语义组合覆盖。
            if kind not in kinds:
                raise ValueError('processing_type incompatible with pipeline: ' + path)
            cases[path] = {'type': kind, 'slot': 'model'}
        elif name.suffix in ['.png', '.webp', '.svg']:
            cases[path] = {'type': 'image', 'slot': 'image'}
        elif name.suffix in ['.json', '.csv']:
            cases[path] = {'type': 'metadata', 'slot': 'metadata'}
    catalog_path = output/'internal/character/character-catalog.json'
    if pipeline == 'characters':
        if not catalog_path.exists():
            raise ValueError('character catalog required')
        catalog = json.loads(catalog_path.read_text())
        bodies = catalog['characters']
        if not bodies:
            raise ValueError('character catalog has no bodies')
        for collection, field in [(bodies, 'character_key'), (catalog['wearables'], 'wearable_key')]:
            if len({item[field] for item in collection}) != len(collection):
                raise ValueError('duplicate character or wearable identity')
        for body in bodies:
            cases['body:' + body['character_key']] = {'type': 'body', 'slot': 'body'}
        for item in catalog['wearables']:
            if item['slot'] not in rules['sampling']['wearable_slots']:
                raise ValueError('unknown wearable slot: ' + item['slot'])
            compatible = [body for body in bodies if item['body_key'] == body['body_key'] and item['rig_key'] == body['rig_key']]
            if not compatible:
                raise ValueError('wearable has no compatible body: ' + item['wearable_key'])
            if not item.get('empty'):
                for body in compatible:
                    key = ':'.join([body['character_key'], item['slot'], item['wearable_key']])
                    cases[key] = {'type': 'wearable', 'slot': item['slot']}
    scenes_name = 'internal/island/spatial-scenes.json'
    if scenes_name in generated:
        previous_path = root/scenes_name
        previous_scenes = {item['scene_key']: item for item in json.loads(previous_path.read_text())} if previous_path.exists() else {}
        for scene in json.loads((output/scenes_name).read_text()):
            if previous_scenes.get(scene['scene_key']) != scene:
                cases['scene:' + scene['scene_key']] = {'type': 'environment', 'slot': 'environment'}
    if pipeline == 'characters':
        references = {item.get('model_asset_key') for item in bodies + catalog['wearables']}
        unassigned = [path for path in generated if path.endswith('.glb') and Path(path).stem not in references]
        if unassigned:
            raise ValueError('unassigned character model: ' + ', '.join(sorted(unassigned)))
    if not cases:
        raise ValueError('empty coverage plan')
    plan = {}
    for case, item in cases.items():
        kind, slot = item['type'], item['slot']
        for rule in rules['types'][kind]['required']:
            if rule != 'visual':
                plan.setdefault(rule, []).append(case)
                continue
            if local_hairstyles and kind == 'wearable':
                for pose in rules['sampling']['local_hairstyles']:
                    time = 'frame:' + str(pose['frame']) if 'frame' in pose else 'time:' + str(pose['normalized_time'])
                    plan.setdefault('visual', []).extend(f"{case}@{view}@{pose['motion']}@{time}" for view in pose['views'])
                continue
            views = ['image'] if kind == 'image' else rules['sampling']['views'] + rules['sampling']['local_views'].get(slot, [])
            poses = [{'motion': 'rest', 'frame': 0}]
            if kind in ['body', 'wearable']:
                poses = rules['sampling']['poses']
            elif kind == 'animation':
                poses = [{'motion': 'clip', 'normalized_time': time} for time in rules['sampling']['motion_samples']]
            for view in views:
                for pose in poses:
                    time = 'frame:' + str(pose['frame']) if 'frame' in pose else 'time:' + str(pose['normalized_time'])
                    plan.setdefault('visual', []).append(f"{case}@{view}@{pose['motion']}@{time}")
            if kind in ['body', 'wearable'] and slot in ['body', 'upper', 'lower', 'shoes', 'back']:
                for motion in rules['sampling']['motions']:
                    for sample in rules['sampling']['motion_samples']:
                        plan['visual'].append(f'{case}@front@{motion}@time:{sample}')
    return {key: sorted(set(value)) for key, value in sorted(plan.items())}


# 自动核对引用闭包，目录缺失的模型不能由隐式fallback补齐。
def check_integrity(root, output, manifest):
    available = {entry['path'] for entry in manifest['generated'] + manifest.get('reused', [])}
    registered = {key: entry.get('format') or 'svg' for key, entry in asset_registry(root, output).items()}
    for entry in manifest['generated']:
        path = Path(entry['path'])
        if path.suffix in ['.png', '.webp']:
            from PIL import Image
            try:
                with Image.open(local_path(output, entry['path'])) as image:
                    image.verify()
            except OSError as error:
                raise ValueError('invalid candidate image: ' + entry['path']) from error
        if path.suffix in ['.glb', '.png', '.webp', '.svg'] and registered.get(path.stem) != path.suffix[1:]:
            raise ValueError('unregistered generated asset: ' + path.name)
    def reference(asset):
        if asset not in registered:
            raise ValueError('unregistered asset reference: ' + asset)
        if f'internal/assets/builtin/{asset}.{registered[asset]}' not in available:
            raise ValueError('undeclared asset reference: ' + asset)
    def visit(value):
        if isinstance(value, str) and value.startswith('/api/v1/assets/'):
            reference(value.rsplit('/', 1)[1])
        elif isinstance(value, dict):
            for key, item in value.items():
                if (key == 'asset_key' or key.endswith('_asset_key')) and isinstance(item, str):
                    reference(item)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    runtime_catalogs = set(json.loads(RULES.read_text())['runtime_catalogs'])
    for name in runtime_catalogs:
        path = local_path(output, name) if name in {entry['path'] for entry in manifest['generated']} else local_path(root, name)
        if path.exists():
            visit(json.loads(path.read_text()))
    for entry in manifest['generated']:
        if entry['path'].endswith('.json'):
            json.loads(local_path(output, entry['path']).read_text())



# 格式检查保留失败报告，工具异常不能让上一轮通过记录继续有效。
def check_gltf(root, output, manifest):
    paths = [str(local_path(output, entry['path'])) for entry in manifest['generated'] if entry['path'].endswith('.glb')]
    if not paths:
        return {'status': 'not_run', 'reason': 'no generated GLB'}
    process = subprocess.run(['node', str(ROOT/'scripts/check-gltf-assets.mjs'), *paths], capture_output=True, text=True)
    try:
        report = json.loads(process.stdout)
        status = 'failed' if process.returncode else ('needs_review' if report['summary']['warnings'] else 'passed')
        # 校验时间不属于格式结论，避免同一报告每次检查都撤销人工警告复核。
        for entry in report.get('files', []):
            entry.get('validation', {}).pop('validatedAt', None)
    except (ValueError, KeyError):
        report = {'error': process.stderr or process.stdout, 'exit_code': process.returncode}
        status = 'failed'
    write_json(output/'gltf-check.json', report)
    return {'status': status, 'report': 'gltf-check.json', 'sha256': digest((output/'gltf-check.json').read_bytes())}


# 检查器本身的依赖也影响结论，不能只绑定制作代码。
def check_dependencies():
    names = ['scripts/asset-pipeline.py', 'scripts/asset-pipeline-candidate.py',
             'scripts/check-gltf-assets.mjs', 'scripts/asset-pipeline-rules.json',
             'package-lock.json', 'node_modules/gltf-validator/package.json']
    return [{'path': str(ROOT/name), 'sha256': digest((ROOT/name).read_bytes())} for name in names if (ROOT/name).exists()]


# 分批证据只覆盖实际案例；后续复核替换相同案例，不抹掉其他已完成案例。
def merge_evidence(output, plan, automatic, records):
    cases = {}
    for index, record in enumerate(records):
        key = record['rule']
        if key not in plan or key == 'integrity':
            raise ValueError('unknown or automatic rule: ' + key)
        coverage = set(record.get('coverage', []))
        if not coverage or not coverage.issubset(set(plan[key])):
            raise ValueError('invalid coverage: ' + key)
        if record.get('status') not in ['passed', 'failed', 'needs_review']:
            raise ValueError('invalid review status: ' + key)
        for case in coverage:
            cases[(key, case)] = index
    active_indices = set(cases.values())
    for index in active_indices:
        record = records[index]
        key = record['rule']
        if key == 'gltf':
            if automatic['gltf']['status'] not in ['passed', 'needs_review']:
                raise ValueError('GLB errors or missing checks cannot be accepted')
            if record.get('automatic_sha256') != automatic['gltf'].get('sha256'):
                raise ValueError('stale automatic warning review')
        if not record.get('evidence'):
            raise ValueError('missing evidence files: ' + key)
        for entry in record['evidence']:
            if digest(local_path(output, entry['path']).read_bytes()) != entry['sha256']:
                raise ValueError('evidence file changed: ' + entry['path'])
    results = dict(automatic)
    for key in plan:
        indices = {index for (rule, case), index in cases.items() if rule == key}
        if not indices:
            continue
        covered = sorted(case for rule, case in cases if rule == key)
        statuses = [records[index]['status'] for index in indices]
        status = 'failed' if 'failed' in statuses else ('passed' if set(covered) == set(plan[key]) and all(value == 'passed' for value in statuses) else 'needs_review')
        evidence = {entry['path']: entry for index in sorted(indices) for entry in records[index]['evidence']}
        results[key] = {**automatic.get(key, {}), 'status': status, 'coverage': covered, 'evidence': list(evidence.values())}
    return summarize_checks(plan, results)


# 自动检查与专项复核分别保存；未完成的案例保留待办，不以总体布尔值代替。
def check(root, output, evidence_path=None):
    manifest = verify_candidate(root, output)
    rules = json.loads(RULES.read_text())
    candidate_hash, rules_hash = digest((output/'candidate.json').read_bytes()), digest(RULES.read_bytes())
    plan = coverage_plan(root, output, manifest, rules)
    automatic = {}
    try:
        check_integrity(root, output, manifest)
        automatic['integrity'] = {'status': 'passed'}
    except (ValueError, OSError) as error:
        automatic['integrity'] = {'status': 'failed', 'reason': str(error)}
    if 'gltf' in plan:
        automatic['gltf'] = check_gltf(root, output, manifest)
    records = []
    report_path = output/'checks.json'
    if report_path.exists():
        previous = json.loads(report_path.read_text())
        if previous.get('candidate_sha256') == candidate_hash and previous.get('rules_sha256') == rules_hash and previous.get('checker_sha256') == digest(Path(__file__).read_bytes()) and previous.get('dependencies') == check_dependencies():
            records = previous.get('review_records', [])
            if previous.get('automatic', {}).get('gltf', {}).get('sha256') != automatic.get('gltf', {}).get('sha256'):
                records = [record for record in records if record['rule'] != 'gltf']
    if evidence_path:
        evidence = json.loads(evidence_path.read_text())
        validate_evidence(evidence, candidate_hash, rules_hash)
        records.extend(evidence.get('results', []))
    results = merge_evidence(output, plan, automatic, records)
    report = {'candidate_sha256': candidate_hash, 'rules_sha256': rules_hash,
              'checker_sha256': digest(Path(__file__).read_bytes()), 'dependencies': check_dependencies(),
              'plan': plan, 'automatic': automatic, 'review_records': records, 'results': results,
              'status': 'passed' if checks_passed(results) else 'incomplete'}
    write_json(report_path, report)
    return report


# 恢复前先核对全部文件，避免部分恢复后才发现外部改动。
def recover(root, journal_path):
    journal = json.loads(journal_path.read_text())
    if journal['state'] not in ['applying', 'recovering']:
        return journal
    for entry in journal['files']:
        path = local_path(root, entry['path'])
        before = base64.b64decode(entry['before']) if entry['before'] is not None else None
        current = path.read_bytes() if path.exists() else None
        current_hash = digest(current) if current is not None else None
        if current != before and current_hash != entry['after_sha256']:
            raise ValueError('recovery target changed: ' + entry['path'])
    journal['state'] = 'recovering'
    write_json(journal_path, journal)
    for entry in reversed(journal['files']):
        path = local_path(root, entry['path'])
        if entry['before'] is None:
            remove_file(path)
        else:
            atomic_write(path, base64.b64decode(entry['before']))
    journal['state'] = 'recovered'
    write_json(journal_path, journal)
    return journal


# 应用锁覆盖整个批次；持久日志支持强制终止后恢复精确旧字节。
def apply(root, output, recovery=False):
    work = root/'.local/asset-pipeline'
    work.mkdir(parents=True, exist_ok=True)
    with (work/'application.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal_path = work/'application.json'
        if recovery:
            return recover(root, journal_path)
        if journal_path.exists() and json.loads(journal_path.read_text())['state'] in ['applying', 'recovering']:
            raise ValueError('unfinished application; use apply --recover')
        manifest = verify_candidate(root, output)
        report = json.loads((output/'checks.json').read_text())
        validate_evidence(report, digest((output/'candidate.json').read_bytes()), digest(RULES.read_bytes()))
        if report.get('checker_sha256') != digest(Path(__file__).read_bytes()):
            raise ValueError('stale checker evidence')
        for entry in report.get('dependencies', []):
            if digest(Path(entry['path']).read_bytes()) != entry['sha256']:
                raise ValueError('check dependency changed: ' + entry['path'])
        check_integrity(root, output, manifest)
        expected = coverage_plan(root, output, manifest, json.loads(RULES.read_text()))
        results = merge_evidence(output, expected, report['automatic'], report.get('review_records', []))
        if report['plan'] != expected or report['results'] != results or not checks_passed(results):
            raise ValueError('required checks have not passed')
        for record in report['results'].values():
            if record.get('report') and digest(local_path(output, record['report']).read_bytes()) != record['sha256']:
                raise ValueError('automatic report changed before application')
            for entry in record.get('evidence', []):
                if digest(local_path(output, entry['path']).read_bytes()) != entry['sha256']:
                    raise ValueError('evidence changed before application')
        new_catalog = output/'internal/assets/builtin/catalog.json'
        old_catalog = root/'internal/assets/builtin/catalog.json'
        if new_catalog.exists() and old_catalog.exists():
            previous = {entry['key']: entry for entry in json.loads(old_catalog.read_text())}
            for entry in json.loads(new_catalog.read_text()):
                if entry['key'] in previous and entry != previous[entry['key']]:
                    raise ValueError('immutable asset metadata changed: ' + entry['key'])
        baseline = {entry['path']: entry['sha256'] for entry in manifest['baseline']}
        retired = manifest.get('retired_source_files', [])
        if 'retired_source_files' in manifest:
            current_paths = {entry['path'] for entry in manifest['generated'] + manifest.get('reused', [])}
            if any(entry['path'] in current_paths for entry in retired):
                raise ValueError('invalid retirement declaration: current resource')
            retirement_baseline = {**baseline, **{entry['path']: entry['sha256'] for entry in retired}}
            if candidate_tools().source_retirements(root, output, retirement_baseline) != retired:
                raise ValueError('invalid retirement declaration: not the registered catalog difference')
        files = []
        contents = {}
        for entry in manifest['generated']:
            path = local_path(root, entry['path'])
            before = path.read_bytes() if path.exists() else None
            if entry['path'] not in baseline or (digest(before) if before is not None else None) != baseline[entry['path']]:
                raise ValueError('application baseline changed: ' + entry['path'])
            if path.suffix in ['.glb', '.png', '.svg', '.webp', '.jpg', '.ogg', '.mp3'] and before is not None and digest(before) != entry['sha256']:
                raise ValueError('immutable asset changed: ' + entry['path'])
            content = local_path(output, entry['path']).read_bytes()
            if digest(content) != entry['sha256']:
                raise ValueError('candidate changed before application: ' + entry['path'])
            contents[entry['path']] = content
            files.append({**entry, 'before': base64.b64encode(before).decode() if before is not None else None, 'after_sha256': entry['sha256']})
        # 旧源码先归档并核对精确字节；持久安装目录不参与本次移动。
        for entry in retired:
            before = local_path(root, entry['path']).read_bytes()
            if digest(before) != entry['sha256']:
                raise ValueError('retirement baseline changed: ' + entry['path'])
            archive_name = '.local/asset-pipeline/retired/' + report['candidate_sha256'] + '/' + entry['path']
            archive = local_path(root, archive_name)
            if archive.exists():
                if archive.read_bytes() != before:
                    raise ValueError('retired archive changed: ' + archive_name)
            else:
                atomic_write(archive, before)
            if digest(archive.read_bytes()) != entry['sha256']:
                raise ValueError('retired archive changed: ' + archive_name)
            files.append({**entry, 'before': base64.b64encode(before).decode(), 'after_sha256': None, 'archive': archive_name})
        journal = {'state': 'applying', 'candidate': str(output), 'candidate_sha256': report['candidate_sha256'], 'application_checks': 'not_run', 'files': files}
        write_json(journal_path, journal)
        try:
            for entry in files:
                path = local_path(root, entry['path'])
                if entry['after_sha256'] is None:
                    if not path.is_file() or digest(path.read_bytes()) != entry['sha256']:
                        raise ValueError('retirement baseline changed before removal: ' + entry['path'])
                    remove_file(path)
                else:
                    atomic_write(path, contents[entry['path']])
        except BaseException:
            recover(root, journal_path)
            raise
        journal['state'] = 'applied'
        write_json(journal_path, journal)
        return {key: value for key, value in journal.items() if key != 'files'}


# CLI只调度用户显式选择的动作，build不自动check或apply。
def main():
    rules = json.loads(RULES.read_text())
    parser = argparse.ArgumentParser(description=rules['messages']['description'], allow_abbrev=False)
    parser.add_argument('action', choices=['inventory', 'build', 'check', 'apply'])
    parser.add_argument('--pipeline', choices=list(rules['pipelines']))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--blender', default='/Applications/Blender.app/Contents/MacOS/Blender')
    parser.add_argument('--recover', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--stage')
    args, extra = parser.parse_known_args()
    if args.action != 'build' and extra:
        parser.error('unexpected arguments: ' + ' '.join(extra))
    if args.recover and args.action != 'apply':
        parser.error('--recover requires apply')
    if args.stage and (args.action != 'build' or args.resume):
        parser.error('--stage requires build and cannot combine with --resume')
    if args.resume and args.action != 'build':
        parser.error('--resume requires build')
    if args.action == 'inventory':
        result = {'pipelines': rules['pipelines'], 'types': rules['types'], 'sampling': rules['sampling']}
    elif args.action == 'build':
        if not args.pipeline or not args.output:
            parser.error('build requires --pipeline and --output')
        tools = candidate_tools()
        output = args.output.resolve()
        tools.validate_candidate_output(ROOT, output)
        pipeline = rules['pipelines'][args.pipeline]
        adapter = pipeline
        if args.stage:
            if args.stage not in pipeline.get('stages', {}):
                raise ValueError('unknown pipeline stage: ' + args.stage)
            previous = verify_candidate(ROOT, output)
            if previous['pipeline'] != args.pipeline:
                raise ValueError('stage pipeline mismatch')
            for entry in previous['baseline']:
                target = local_path(ROOT, entry['path'])
                if (digest(target.read_bytes()) if target.exists() else None) != entry['sha256']:
                    raise ValueError('stage baseline changed: ' + entry['path'])
            adapter = pipeline['stages'][args.stage]
        if args.resume and not adapter.get('resume'):
            raise ValueError('pipeline does not support resume: ' + args.pipeline)
        if not args.stage and output.exists() and any(output.iterdir()):
            if not args.resume:
                raise ValueError('build requires an empty candidate directory or --resume')
            previous_path = output/'candidate.json'
            if previous_path.exists():
                previous = json.loads(previous_path.read_text())
                if previous['pipeline'] != args.pipeline or previous['states']['processing'] == 'passed':
                    raise ValueError('cannot resume a completed or different candidate')
        script = str(ROOT/'scripts'/adapter['script'])
        command = [sys.executable, script] if adapter['runtime'] == 'python' else [args.blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--']
        if extra[:1] == ['--']:
            extra = extra[1:]
        output_flags = ['--output', *adapter.get('output_aliases', [])]
        if any(value.startswith('--') and any(flag.startswith(value.split('=')[0]) for flag in output_flags) for value in extra):
            raise ValueError('adapter cannot override output')
        baseline = tools.capture_baseline(ROOT)
        dependency_names = ['scripts/asset-pipeline.py', 'scripts/asset-pipeline-candidate.py', 'scripts/asset-pipeline-rules.json', 'scripts/' + adapter['script'], 'pyproject.toml', 'uv.lock']
        dependencies = tools.capture_dependencies(ROOT, [str(ROOT/name) for name in dependency_names if (ROOT/name).exists()])
        if args.stage:
            dependencies += previous.get('dependencies', [])
        if args.resume and adapter.get('resume_argument'):
            extra = ['--resume', *extra]
        if adapter.get('forward_blender'):
            extra = ['--blender', args.blender, *extra]
        subprocess.run([*command, '--output', str(output), *extra], check=True, cwd=ROOT)
        adapter_manifest = json.loads((output/'candidate.json').read_text()) if (output/'candidate.json').exists() else {}
        if adapter_manifest and adapter_manifest['pipeline'] != args.pipeline:
            raise ValueError('adapter pipeline mismatch')
        combined_dependencies = {}
        for entry in [*dependencies, *adapter_manifest.get('dependencies', [])]:
            if entry['path'] in combined_dependencies and combined_dependencies[entry['path']]['sha256'] != entry['sha256']:
                raise ValueError('dependency changed during build: ' + entry['path'])
            combined_dependencies[entry['path']] = entry
        tools.finalize_candidate(ROOT, output, args.pipeline, baseline=baseline,
                                 reused_paths=[entry['path'] for entry in adapter_manifest.get('reused', [])],
                                 dependencies=list(combined_dependencies.values()),
                                 processing=adapter_manifest.get('states', {}).get('processing', 'passed'),
                                 tool_versions={**adapter_manifest.get('tool_versions', {}), 'orchestrator_python': sys.version})
        processing = adapter_manifest.get('states', {}).get('processing', 'passed')
        result = {'candidate': str(output), 'processing': processing, 'checks': 'not_run'}
    else:
        if not args.output and not args.recover:
            parser.error('check/apply requires --output')
        output = args.output.resolve() if args.output else None
        result = check(ROOT, output, args.evidence) if args.action == 'check' else apply(ROOT, output, args.recover)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get('status') == 'incomplete' or result.get('processing', 'passed') != 'passed' else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.loads(RULES.read_text())['messages']['failure'].format(error=error), file=sys.stderr)
        raise SystemExit(1)
