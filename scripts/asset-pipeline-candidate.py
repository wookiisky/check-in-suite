"""素材候选的文件清单、正式基线及显式复用；不更新正式目录。"""
import hashlib
import json
import struct
import sys
from urllib.parse import unquote, urlsplit
from pathlib import Path


# 对文件实际字节取摘要，所有入口共用相同身份依据。
def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 仓库内仅允许本地工作目录，仓库外不能选择仓库祖先。
def validate_candidate_output(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    if root.is_relative_to(output) or (output.is_relative_to(root) and not output.is_relative_to(root/'.local')):
        raise ValueError('candidate output must stay in .local or outside repository')
    return output


# 在构建开始固定正式文件基线，应用时只能核对本次涉及的文件。
def capture_baseline(root):
    root = Path(root).resolve()
    return {path.relative_to(root).as_posix(): file_hash(path)
            for path in sorted((root/'internal').rglob('*')) if path.is_file()}


# 从实际GLTF/GLB声明枚举外链，内嵌数据已由主文件哈希覆盖。
def source_dependencies(source):
    source = Path(source).resolve()
    paths = [source]
    if source.suffix.lower() not in ['.gltf', '.glb']:
        return paths
    data = source.read_bytes()
    if source.suffix.lower() == '.gltf':
        document = json.loads(data)
    else:
        if len(data) < 20:
            raise ValueError('invalid source GLB header: ' + str(source))
        magic, version, length, chunk_length, chunk_type = struct.unpack_from('<IIIII', data)
        if magic != 0x46546C67 or version != 2 or length != len(data) or chunk_type != 0x4E4F534A or 20+chunk_length > len(data):
            raise ValueError('invalid source GLB container: ' + str(source))
        document = json.loads(data[20:20+chunk_length])
    for item in [*document.get('buffers', []), *document.get('images', [])]:
        uri = item.get('uri')
        if not uri or uri.startswith('data:'):
            continue
        parsed = urlsplit(uri)
        if parsed.scheme or parsed.netloc:
            raise ValueError('non-local source dependency: ' + uri)
        paths.append((source.parent/unquote(parsed.path)).resolve())
    return list(dict.fromkeys(paths))


# 配方与工具在构建前取指纹，结束时再次核对以防混用不同版本。
def capture_dependencies(root, paths):
    root = Path(root).resolve()
    records = []
    for value in paths:
        path = Path(value)
        path = path if path.is_absolute() else root/path
        records.append({'path': str(path.resolve()), 'sha256': file_hash(path)})
    return records


# 退役仅取旧、新注册目录的资源差集，未注册文件及辅助清单不在移动范围内。
def source_retirements(root, output, baseline):
    catalog_name = 'internal/assets/builtin/catalog.json'
    previous, current = root/catalog_name, output/catalog_name
    if not current.is_file():
        return []
    if not previous.is_file():
        if baseline.get(catalog_name) is not None:
            raise ValueError('retirement catalog changed during build: ' + catalog_name)
        return []
    if file_hash(previous) != baseline.get(catalog_name):
        raise ValueError('retirement catalog changed during build: ' + catalog_name)
    builtin = (root/'internal/assets/builtin').resolve()

    def paths(catalog):
        result = set()
        for item in json.loads(catalog.read_text()):
            name = Path('internal/assets/builtin')/(item['key']+'.'+(item.get('format') or 'svg'))
            if name.parent != Path('internal/assets/builtin') or (root/name).resolve().parent != builtin or name.name in ['catalog.json', 'reused-assets.json']:
                raise ValueError('invalid registered source path: ' + str(name))
            result.add(name.as_posix())
        return result

    retired = []
    for name in sorted(paths(previous)-paths(current)):
        path = root/name
        if path.is_symlink():
            raise ValueError('retirement source is a symlink: ' + name)
        before = baseline.get(name)
        if not path.exists() and before is None:
            continue
        if not path.is_file() or file_hash(path) != before:
            raise ValueError('retirement source changed during build: ' + name)
        retired.append({'path': name, 'sha256': before})
    return retired


# 所有类别生成相同候选契约；目录中的既有资源必须显式登记精确哈希。
def finalize_candidate(root, output, pipeline, reused_paths=(), baseline=None, dependencies=(), processing='passed', tool_versions=None):
    root = Path(root).resolve()
    output = validate_candidate_output(root, output)
    if baseline is None:
        raise ValueError('candidate baseline must be captured before build')
    files = [path for path in sorted((output/'internal').rglob('*'))
             if path.is_file() and path.name != 'reused-assets.json']
    for path in files:
        if not path.resolve().is_relative_to(output):
            raise ValueError('candidate file escapes output: ' + str(path))
    generated = [{'path': path.relative_to(output).as_posix(), 'sha256': file_hash(path)} for path in files]
    generated_paths = {entry['path'] for entry in generated}
    reuse = {Path(path).relative_to(root).as_posix() if Path(path).is_absolute() else Path(path).as_posix()
             for path in reused_paths}
    catalog = output/'internal/assets/builtin/catalog.json'
    if catalog.exists():
        for asset in json.loads(catalog.read_text()):
            reuse.add('internal/assets/builtin/' + asset['key'] + '.' + (asset.get('format') or 'svg'))
    rules = root/'scripts/asset-pipeline-rules.json'
    if rules.is_file():
        reuse.update(name for name in json.loads(rules.read_text()).get('runtime_catalogs', [])
                     if name in baseline or (root/name).exists())
    reuse -= generated_paths
    retired = source_retirements(root, output, baseline)
    if any(entry['path'] in generated_paths | reuse for entry in retired):
        raise ValueError('retired source overlaps current generated or reused resource')
    reused = []
    for name in sorted(reuse):
        path = (root/name).resolve()
        if not path.is_relative_to(root/'internal'):
            raise ValueError('candidate reused path outside internal: ' + name)
        digest = file_hash(path)
        if baseline.get(name) != digest:
            raise ValueError('candidate reused asset changed during build: ' + name)
        reused.append({'path': name, 'sha256': digest})
    changed = [{'path': entry['path'], 'sha256': baseline.get(entry['path'])} for entry in generated]
    dependency_records = []
    for value in dependencies:
        if isinstance(value, dict):
            record = dict(value)
            if file_hash(record['path']) != record['sha256']:
                raise ValueError('candidate dependency changed during build: ' + record['path'])
        else:
            record = capture_dependencies(root, [value])[0]
        dependency_records.append(record)
    if tool_versions is None:
        tool_versions = {'python': sys.version}
        blender = sys.modules.get('bpy')
        if blender is not None:
            tool_versions['blender'] = blender.app.version_string
    else:
        tool_versions = dict(tool_versions)
    manifest = {'schema_version': 1, 'tool_versions': tool_versions, 'pipeline': pipeline, 'generated': generated, 'reused': reused,
                'baseline': changed, 'dependencies': dependency_records, 'retired_source_files': retired,
                'states': {'processing': processing, 'checks': 'not_run', 'visual_review': 'pending',
                           'promotion': 'not_run', 'application_checks': 'not_run'}}
    output.mkdir(parents=True, exist_ok=True)
    reuse_file = output/'internal/assets/builtin/reused-assets.json'
    reuse_file.parent.mkdir(parents=True, exist_ok=True)
    reuse_file.write_text(json.dumps({Path(item['path']).name: item['sha256'] for item in reused}, indent=2)+'\n')
    temporary = output/'candidate.json.tmp'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    temporary.replace(output/'candidate.json')
    return manifest
