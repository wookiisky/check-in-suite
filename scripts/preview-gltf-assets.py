"""以当前目录或显式 GLB 输入生成可复用的四视角预览与总览图。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIRECTORY = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIRECTORY / 'preview-gltf-content.json'
CONTENT = json.loads(CONTENT_PATH.read_text())
RENDERER = SCRIPT_DIRECTORY / 'render-gltf-previews.py'
RENDER_CONTENT = SCRIPT_DIRECTORY / 'render-gltf-previews-content.json'


# 同一份实际字节用于输入和产物完整性核对。
def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 人物默认外观沿用服装覆盖规则，不把隐藏身体和替代衣服同时画出来。
def character_visible_nodes(character, wearables):
    nodes = list(character['fixed_nodes'])
    covered = set()
    outfits = []
    for key in character['defaults'].values():
        if key not in wearables:
            raise ValueError(CONTENT['errors']['invalid_visible_nodes'].format(key=key))
        outfits.append(wearables[key])
        covered.update(wearables[key]['covers'])
    for region, names in character['body_regions'].items():
        if region not in covered:
            nodes.extend(names)
    for wearable in outfits:
        nodes.extend(wearable['nodes'])
    return list(dict.fromkeys(nodes))


# 当前发布清单决定默认范围，完整本地候选库不会自动进入预览任务。
def catalog_items(kind):
    builtin = ROOT / 'internal/assets/builtin'
    if kind == 'characters':
        catalog = json.loads((ROOT / 'internal/character/character-catalog.json').read_text())
        wearables = {item['wearable_key']: item for item in catalog['wearables']}
        return [{'key': item['character_key'], 'name': item['name'], 'provider': item.get('provider', ''), 'model': str(builtin / (item['model_asset_key'] + '.glb')), 'visible_nodes': character_visible_nodes(item, wearables), 'scale': item['scale']} for item in catalog['characters']]
    manifest = json.loads((ROOT / 'internal/assets/provider-asset-manifest.json').read_text())
    return [{'key': item['key'], 'name': item['name'], 'provider': item.get('provider', ''), 'category': item.get('category', ''), 'model': str(builtin / (item['key'] + '.glb'))} for item in manifest['selected_assets'] if item['format'] == 'glb']


# 显式路径可预览尚未上架的房屋，重复发现的同一文件只处理一次。
def input_items(paths):
    files = {}
    for value in paths:
        path = Path(value).resolve()
        candidates = sorted(path.rglob('*.glb')) if path.is_dir() else [path]
        for model in candidates:
            files.setdefault(model, {'key': model.stem + '-' + hashlib.sha256(str(model).encode()).hexdigest()[:8], 'name': model.stem, 'model': str(model)})
    return list(files.values())


# 缓存同时绑定模型、显隐、尺度、工具版本及渲染代码，避免旧画面冒充新结果。
def render_fingerprint(item, settings, version):
    recipe = {field: item[field] for field in ('model', 'visible_nodes', 'scale') if field in item}
    recipe.update(model_sha256=file_sha256(item['model']), settings=settings, blender_version=version,
                  pipeline={str(path.name): file_sha256(path) for path in (RENDERER, RENDER_CONTENT)})
    return hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()


# 只复用完整且字节未变化的 PNG；仅文件存在不足以证明成功。
def cached_result(previous, fingerprint, views):
    if previous.get('fingerprint') != fingerprint or previous.get('status') not in ('rendered', 'cached'):
        return False
    files, hashes = previous.get('files', []), previous.get('file_sha256', {})
    if len(files) != len(views):
        return False
    try:
        for path in files:
            if file_sha256(path) != hashes.get(path):
                return False
            with Image.open(path) as image:
                image.verify()
        return True
    except (OSError, ValueError):
        return False


# 缓存只是加速记录，损坏时重新渲染，不能影响只读模型本身。
def read_cache(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


# 结果写入使用同目录原子替换，中断时保留上一次可读清单。
def write_manifest(path, report):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as temporary:
        json.dump(report, temporary, ensure_ascii=False, indent=2)
        temporary.write('\n')
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)


# 所有待更新模型共用一次 Blender 进程，日志和逐项错误留在输出目录。
def render_batch(jobs, settings, blender, output):
    if not jobs:
        return {}
    with tempfile.TemporaryDirectory(prefix='preview-jobs-', dir=output) as temporary:
        request_path = Path(temporary) / 'jobs.json'
        result_path = Path(temporary) / 'results.json'
        request_path.write_text(json.dumps({'jobs': jobs, 'settings': settings, 'result_path': str(result_path)}))
        process = subprocess.run([blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python', str(RENDERER), '--', '--jobs', str(request_path)], capture_output=True, text=True)
        (output / 'renderer.log').write_text(process.stdout + '\n' + process.stderr)
        if not result_path.exists():
            return {}
        result = json.loads(result_path.read_text())
        return {item['key']: item for item in result['items']}


# 字体可显式指定；常见系统优先使用支持中文的字体。
def preview_font(path, size):
    candidates = [path] if path else ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


# 每行按统一顺序展示一个模型，失败项保留位置，避免比较时静默缺项。
def contact_sheets(items, output, options):
    size, gap = options.size, 12
    row_height, header = size + 76, 32
    views = CONTENT['settings']['views']
    width = gap + (size + gap) * len(views)
    font = preview_font(options.font, 14)
    small_font = preview_font(options.font, 12)
    paths = []
    for offset in range(0, len(items), options.page_size):
        rows = items[offset:offset + options.page_size]
        sheet = Image.new('RGB', (width, header + row_height * len(rows)), '#f1f3f5')
        draw = ImageDraw.Draw(sheet)
        for column, view in enumerate(views):
            draw.text((gap + column * (size + gap), 6), CONTENT['views'][view], fill='#263238', font=font)
        for row, item in enumerate(rows):
            y = header + row * row_height
            label = f"{offset + row + 1}. {item.get('name', item['key'])} · {item.get('provider', '')}"
            draw.text((gap, y), label, fill='#263238', font=font)
            draw.text((gap, y + 20), item['key'], fill='#455a64', font=small_font)
            if item['status'] == 'failed':
                draw.text((gap, y + 44), CONTENT['failed'], fill='#b71c1c', font=font)
                continue
            bounds = item['bounds_m']
            draw.text((gap, y + 38), CONTENT['dimensions'].format(**dict(zip(('x', 'y', 'z'), [upper - lower for lower, upper in bounds]))), fill='#455a64', font=small_font)
            for column, path in enumerate(item['files']):
                with Image.open(path) as image:
                    image = image.convert('RGBA')
                    image.thumbnail((size, size))
                    sheet.paste(image, (gap + column * (size + gap), y + 62), image)
        path = output / f'contact-{offset // options.page_size + 1:03d}.png'
        sheet.save(path)
        paths.append(str(path))
    return paths


# 调度只写预览目录，正式模型与发布清单始终只读。
def run_preview(options):
    output = Path(options.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / 'preview-manifest.json'
    cache_path = output / 'preview-cache.json'
    previous = read_cache(cache_path)
    cached = {item['key']: item for item in previous.get('items', [])}
    items = input_items(options.input) if options.input else catalog_items(options.kind or 'selected')
    if options.only:
        items = [item for item in items if item['key'] in options.only]
    if options.limit:
        items = items[:options.limit]
    if not items:
        raise ValueError(CONTENT['errors']['empty'])
    settings = {**json.loads(RENDER_CONTENT.read_text())['defaults'], 'size': options.size, 'views': CONTENT['settings']['views']}
    version = subprocess.run([options.blender, '--version'], check=True, capture_output=True, text=True).stdout.splitlines()[0]
    jobs, results = [], []
    for item in items:
        item = dict(item)
        model = Path(item['model'])
        if not model.is_file() or model.suffix.lower() != '.glb':
            results.append({**item, 'status': 'failed', 'error': CONTENT['errors']['missing_model'].format(path=model)})
            continue
        fingerprint = render_fingerprint(item, settings, version)
        if not options.force and cached_result(cached.get(item['key'], {}), fingerprint, settings['views']):
            results.append({**cached[item['key']], **item, 'status': 'cached'})
            continue
        directory = output / 'items' / hashlib.sha256(item['key'].encode()).hexdigest()[:16] / fingerprint[:16]
        jobs.append({**item, 'output_directory': str(directory)})
        results.append({**item, 'fingerprint': fingerprint, 'status': 'pending'})
    rendered = render_batch(jobs, settings, options.blender, output)
    for item in results:
        if item['status'] != 'pending':
            continue
        result = rendered.get(item['key'], {'status': 'failed', 'error': CONTENT['errors']['blender_failed']})
        item.update(result)
        if item['status'] == 'rendered':
            try:
                if len(item['files']) != len(settings['views']):
                    raise ValueError(CONTENT['errors']['missing_image'])
                for path in item['files']:
                    with Image.open(path) as image:
                        image.verify()
                item['file_sha256'] = {path: file_sha256(path) for path in item['files']}
            except (OSError, ValueError, KeyError) as error:
                item.update(status='failed', error=str(error))
    summary = {status: sum(item['status'] == status for item in results) for status in ('rendered', 'cached', 'failed')}
    report = {'settings': settings, 'blender_version': version, 'summary': summary, 'items': results, 'sheets': contact_sheets(results, output, options)}
    write_manifest(manifest_path, report)
    cached.update({item['key']: item for item in results})
    write_manifest(cache_path, {'items': list(cached.values())})
    print(CONTENT['summary'].format(**summary, path=manifest_path))
    return int(summary['failed'] > 0)


# 默认只预览本次正式选入摆设，也可显式选择人物或新房屋文件。
def main():
    parser = argparse.ArgumentParser(description=CONTENT['description'])
    helps = CONTENT['arguments']
    parser.add_argument('--input', action='append', default=[], help=helps['input'])
    parser.add_argument('--kind', choices=['selected', 'characters'], help=helps['kind'])
    parser.add_argument('--only', action='append', default=[], help=helps['only'])
    parser.add_argument('--limit', type=int, help=helps['limit'])
    parser.add_argument('--output', default=str(ROOT / '.local/asset-tools/previews'), help=helps['output'])
    parser.add_argument('--blender', default=os.environ.get('BLENDER_PATH') or shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender', help=helps['blender'])
    parser.add_argument('--size', type=int, default=256, help=helps['size'])
    parser.add_argument('--page-size', type=int, default=6, help=helps['page_size'])
    parser.add_argument('--font', help=helps['font'])
    parser.add_argument('--force', action='store_true', help=helps['force'])
    options = parser.parse_args()
    if min(options.size, options.page_size, options.limit if options.limit is not None else 1) <= 0:
        parser.error(CONTENT['errors']['positive'])
    if options.input and options.kind:
        parser.error(CONTENT['errors']['input_kind'])
    try:
        return run_preview(options)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(CONTENT['errors']['worker_unavailable'].format(error=error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
