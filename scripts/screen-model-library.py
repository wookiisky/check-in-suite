"""只读盘点模型目录，按资源线索分组并生成待复核报告。"""
import argparse
import csv
import html
import json
import os
import struct
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


DEFAULT_SOURCE = Path('/Users/air/Downloads/Model')
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / '.local/model-asset-screening'
WEARABLE_PREFIXES = ('accessory', 'bag', 'bottoms', 'cap', 'player', 'shoes', 'socks', 'tops')
SCENE_PREFIXES = ('bridge', 'ceiling', 'fld', 'floor', 'fence', 'house', 'island', 'road', 'river', 'room', 'wall')
DISPLAY_PREFIXES = ('bromide', 'idr', 'layout', 'npc', 'poster', 'uniticon')
PRIMITIVE_TAGS = {'lines', 'linestrips', 'polygons', 'polylist', 'triangles', 'trifans', 'tristrips'}


def local_name(tag):
    return tag.rsplit('}', 1)[-1].lower()


def categorize(name):
    key = name.split('.', 1)[0].lower()
    if key.startswith('furnituretops'):
        return '其他模型（家具部件）', False
    if key.startswith(WEARABLE_PREFIXES):
        return '3D装扮候选', True
    if key.startswith('ftr'):
        return '营地摆件候选', True
    if key.startswith(SCENE_PREFIXES):
        return '场景搭建部件', False
    if key.startswith(DISPLAY_PREFIXES):
        return '图标、展示或角色资源', False
    if key.startswith(('tool', 'fish', 'insect', 'fossil')):
        return '工具或收藏物（待判断）', False
    return '其他模型（待判断）', False


def slot_hint(name, category):
    if category != '3D装扮候选':
        return '—'
    key = name.split('.', 1)[0].lower()
    if key.startswith('bag'):
        return '背部线索'
    if key.startswith(('bottoms', 'playerbottoms')):
        return '下装线索'
    if key.startswith(('shoes', 'sock', 'playershoes')):
        return '鞋袜线索'
    if key.startswith('cap'):
        return '头部线索'
    if key.startswith('tops') or key.startswith('playertops'):
        return '上装/连身衣线索'
    if key.startswith('accessory'):
        return '配件线索（部位待定）'
    return '槽位待定'


def png_dimensions(path):
    try:
        with path.open('rb') as stream:
            header = stream.read(24)
        if header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
            return None
        return [*struct.unpack('>II', header[16:24])]
    except OSError:
        return None


def inspect_dae(path):
    counts = Counter()
    image_refs = []
    image_definitions = {}
    stack = []
    try:
        for event, element in ET.iterparse(path, events=('start', 'end')):
            if event == 'start':
                stack.append(element)
                continue
            tag = local_name(element.tag)
            if tag in {'geometry', 'mesh', 'controller', 'skin', 'node', 'visual_scene'}:
                counts[tag] += 1
            if tag in PRIMITIVE_TAGS:
                counts['primitives'] += 1
            if tag == 'init_from' and element.text and element.text.strip() and len(stack) > 1:
                parent = stack[-2]
                if local_name(parent.tag) == 'image' and parent.attrib.get('id'):
                    image_definitions[parent.attrib['id']] = element.text.strip()
            element.clear()
            stack.pop()
        image_refs.extend(image_definitions.values())
        return {
            'path': path,
            'parse_ok': True,
            'geometry_count': counts['geometry'],
            'mesh_count': counts['mesh'],
            'primitive_count': counts['primitives'],
            'controller_count': counts['controller'],
            'skin_count': counts['skin'],
            'node_count': counts['node'],
            'images': image_refs,
            'error': None,
        }
    except (ET.ParseError, OSError, ValueError) as error:
        return {
            'path': path,
            'parse_ok': False,
            'geometry_count': 0,
            'mesh_count': 0,
            'primitive_count': 0,
            'controller_count': 0,
            'skin_count': 0,
            'node_count': 0,
            'images': [],
            'error': str(error),
        }


def resolve_image_ref(dae_path, reference):
    parsed = urllib.parse.urlsplit(reference)
    if parsed.scheme or parsed.netloc:
        return None
    return (dae_path.parent / urllib.parse.unquote(parsed.path)).resolve()


def scan_source(source):
    extension_counts = Counter()
    file_count = 0
    root_files = []
    models = {}
    images_by_name = {}
    for current, directories, filenames in os.walk(source, followlinks=False):
        directories.sort()
        base = Path(current)
        if base == source:
            root_files.extend(filenames)
        for filename in filenames:
            path = base / filename
            extension = path.suffix.lower() or '[无扩展名]'
            extension_counts[extension] += 1
            file_count += 1
            try:
                relative = path.relative_to(source)
            except ValueError:
                continue
            if not relative.parts:
                continue
            group = relative.parts[0]
            entry = models.setdefault(group, {'files': [], 'dae': [], 'png': []})
            entry['files'].append(path)
            if extension == '.dae':
                entry['dae'].append(path)
            elif extension == '.png':
                entry['png'].append(path)
                images_by_name.setdefault(filename.casefold(), []).append(path)
            elif extension in {'.jpg', '.jpeg', '.tga', '.bmp', '.tif', '.tiff', '.dds', '.webp'}:
                images_by_name.setdefault(filename.casefold(), []).append(path)
    return file_count, extension_counts, root_files, models, images_by_name


def build_records(source, groups, images_by_name):
    records = []
    image_only_count = 0
    for name in sorted(groups, key=str.casefold):
        group = groups[name]
        if not group['dae']:
            if group['png']:
                image_only_count += 1
            continue
        category, is_candidate = categorize(name)
        dae_records = [inspect_dae(path) for path in sorted(group['dae'])]
        missing_images = []
        external_images = []
        ambiguous_images = []
        for dae in dae_records:
            for reference in dae['images']:
                resolved = resolve_image_ref(dae['path'], reference)
                if resolved is not None and resolved.is_file():
                    continue
                candidates = images_by_name.get(Path(urllib.parse.urlsplit(reference).path).name.casefold(), [])
                record = {'dae': str(dae['path'].relative_to(source)), 'reference': reference}
                if len(candidates) == 1:
                    record['resolved_path'] = str(candidates[0].relative_to(source))
                    external_images.append(record)
                elif candidates:
                    record['matches'] = [str(path.relative_to(source)) for path in candidates[:5]]
                    record['match_count'] = len(candidates)
                    ambiguous_images.append(record)
                else:
                    missing_images.append(record)
        parsed = [item for item in dae_records if item['parse_ok']]
        has_geometry = any(item['geometry_count'] > 0 and item['primitive_count'] > 0 for item in parsed)
        parse_failures = sum(not item['parse_ok'] for item in dae_records)
        reasons = []
        if parse_failures:
            reasons.append(f'{parse_failures} 个 DAE 无法解析')
        if not has_geometry:
            reasons.append('未发现含图元的网格几何')
        if missing_images:
            reasons.append(f'{len(missing_images)} 个贴图引用缺失或无法解析')
        if ambiguous_images:
            reasons.append(f'{len(ambiguous_images)} 个贴图文件名有多个候选，需人工匹配')
        if external_images:
            reasons.append(f'{len(external_images)} 个贴图在其他目录找到，打包前需补齐依赖')
        if not group['png']:
            reasons.append('目录中没有 PNG 预览或贴图')
        if len(group['dae']) > 1:
            reasons.append(f'含 {len(group["dae"])} 个 DAE，需确认是否为变体或零件')
        if is_candidate and has_geometry and not parse_failures and not missing_images and not ambiguous_images:
            status = '待补齐外部贴图' if external_images else '待人工看图'
        elif is_candidate:
            status = '待修复或复核'
        elif not has_geometry or parse_failures:
            status = '结构检查未通过'
        else:
            status = '非目标类别'

        pngs = sorted(group['png'], key=lambda path: (
            0 if any(token in path.name.lower() for token in ('icon', 'ftricon', 'closeticon')) else 1,
            0 if '_alb' in path.name.lower() else 1,
            path.name.casefold(),
        ))
        preview = next((path for path in pngs if 'icon' in path.name.lower()), None)
        if preview is None:
            preview = next((path for path in pngs if '_alb' not in path.name.lower() and '_nrm' not in path.name.lower() and '_mix' not in path.name.lower()), None)
        if preview is None and pngs:
            preview = pngs[0]
        records.append({
            'name': name,
            'category': category,
            'slot_hint': slot_hint(name, category),
            'candidate_by_name': is_candidate,
            'status': status,
            'reason': reasons,
            'model_files': [str(path.relative_to(source)) for path in sorted(group['dae'])],
            'model_count': len(group['dae']),
            'png_count': len(group['png']),
            'preview': str(preview.relative_to(source)) if preview else None,
            'preview_dimensions': png_dimensions(preview) if preview else None,
            'geometry_count': sum(item['geometry_count'] for item in dae_records),
            'primitive_count': sum(item['primitive_count'] for item in dae_records),
            'controller_count': sum(item['controller_count'] for item in dae_records),
            'skin_count': sum(item['skin_count'] for item in dae_records),
            'missing_images': missing_images,
            'external_images': external_images,
            'ambiguous_images': ambiguous_images,
            'parse_failures': [
                {'path': str(item['path'].relative_to(source)), 'error': item['error']}
                for item in dae_records if not item['parse_ok']
            ],
            'rights_status': '来源与许可未核实',
            'visual_fit_status': '未验证',
            'placement_status': '未验证',
        })
    return records, image_only_count


def summarize(file_count, extension_counts, groups, records, image_only_count):
    categories = Counter(item['category'] for item in records)
    statuses = Counter(item['status'] for item in records)
    return {
        'source': str(DEFAULT_SOURCE),
        'file_count': file_count,
        'directory_count': len(groups),
        'model_directory_count': len(records),
        'image_only_directory_count': image_only_count,
        'extension_counts': dict(sorted(extension_counts.items(), key=lambda pair: (-pair[1], pair[0]))),
        'category_counts': dict(categories),
        'status_counts': dict(statuses),
        'candidate_counts': {
            'wearables': sum(item['candidate_by_name'] and item['category'] == '3D装扮候选' for item in records),
            'camp_items': sum(item['candidate_by_name'] and item['category'] == '营地摆件候选' for item in records),
            'structurally_reviewable': sum(item['status'] in {'待人工看图', '待补齐外部贴图'} for item in records),
            'needs_repair_or_review': sum(item['status'] == '待修复或复核' for item in records),
            'external_image_dependencies': sum(len(item['external_images']) for item in records),
            'unresolved_image_references': sum(len(item['missing_images']) + len(item['ambiguous_images']) for item in records),
        },
        'rights_status': '目录名和文件本身无法证明来源权利；全部记录待核实。',
    }


def file_uri(source, relative):
    if not relative:
        return ''
    return (source / relative).resolve().as_uri()


def write_outputs(source, output, file_count, extension_counts, groups, records, image_only_count):
    output.mkdir(parents=True, exist_ok=True)
    summary = summarize(file_count, extension_counts, groups, records, image_only_count)
    summary['source'] = str(source)
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (output / 'models.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with (output / 'candidates.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        fields = ['name', 'category', 'slot_hint', 'status', 'model_count', 'geometry_count', 'primitive_count', 'controller_count', 'skin_count', 'png_count', 'preview', 'reason', 'rights_status', 'visual_fit_status', 'placement_status']
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        for item in records:
            writer.writerow({**item, 'reason': '；'.join(item['reason'])})

    rows = []
    for item in records:
        preview = file_uri(source, item['preview'])
        link = f'<a href="{html.escape(preview, quote=True)}">打开图片</a>' if preview else '无预览'
        model_link = file_uri(source, item['model_files'][0]) if item['model_files'] else ''
        model = f'<a href="{html.escape(model_link, quote=True)}">{html.escape(item["model_files"][0])}</a>' if model_link else '—'
        rows.append(
            '<tr data-category="{}" data-status="{}"><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>'.format(
                html.escape(item['category'], quote=True), html.escape(item['status'], quote=True),
                html.escape(item['name']), html.escape(item['category']), html.escape(item['slot_hint']), html.escape(item['status']),
                f'{item["geometry_count"]} / {item["primitive_count"]}',
                f'{item["controller_count"]} / {item["skin_count"]}',
                f'{link}<br>{model}<br>{html.escape("；".join(item["reason"]))}'
            )
        )
    summary_lines = ''.join(f'<li>{html.escape(key)}：{value}</li>' for key, value in summary['category_counts'].items())
    status_lines = ''.join(f'<li>{html.escape(key)}：{value}</li>' for key, value in summary['status_counts'].items())
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model 素材筛选报告</title>
<style>body{font:15px system-ui,sans-serif;max-width:1500px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.45rem;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f3f4f6}input,select{padding:.5rem;margin:.25rem}.warning{background:#fff5d6;padding:.8rem}td:last-child{min-width:300px}code{overflow-wrap:anywhere}</style>
<h1>Model 素材筛选报告</h1><p>来源：<code>__SOURCE__</code>；共 __FILES__ 个文件、__DIRS__ 个目录；__MODELS__ 个目录包含 DAE，另有 __IMAGE_ONLY__ 个仅含 PNG 的目录。</p>
<div class="warning"><strong>筛选边界：</strong>类别来自目录名称规则；结构检查只证明 DAE 可解析并含网格图元。报告不证明模型完整、装扮骨架兼容、营地占地正确、视觉合格或来源许可。全部候选均须人工查看，来源/许可状态为待确认。</div>
<h2>分类计数</h2><ul>__CATEGORIES__</ul><h2>筛选状态</h2><ul>__STATUSES__</ul>
<label>搜索 <input id="search" type="search" placeholder="名称或路径"></label><label>类别 <select id="category"><option value="">全部</option>__OPTIONS__</select></label><label>状态 <select id="status"><option value="">全部</option>__STATUS_OPTIONS__</select></label>
<p>表格有 __ROWS__ 项。PNG预览与模型原件通过本地文件链接打开，不会复制或改写素材。</p><table><thead><tr><th>资源目录</th><th>类别</th><th>槽位线索</th><th>状态</th><th>几何/图元数</th><th>控制器/蒙皮数</th><th>预览、模型与提示</th></tr></thead><tbody>__ROWS_HTML__</tbody></table>
<script>const q=document.querySelector('#search'),c=document.querySelector('#category'),s=document.querySelector('#status');function filter(){for(const r of document.querySelectorAll('tbody tr')){r.hidden=!(r.innerText.toLowerCase().includes(q.value.toLowerCase())&&(!c.value||r.dataset.category===c.value)&&(!s.value||r.dataset.status===s.value))}}for(const e of [q,c,s])e.addEventListener('input',filter)</script></html>'''
    categories = sorted({item['category'] for item in records})
    statuses = sorted({item['status'] for item in records})
    page = page.replace('__SOURCE__', html.escape(str(source))).replace('__FILES__', str(file_count)).replace('__DIRS__', str(len(groups))).replace('__MODELS__', str(len(records))).replace('__IMAGE_ONLY__', str(image_only_count)).replace('__CATEGORIES__', summary_lines).replace('__STATUSES__', status_lines).replace('__ROWS__', str(len(records))).replace('__ROWS_HTML__', ''.join(rows))
    page = page.replace('__OPTIONS__', ''.join(f'<option>{html.escape(value)}</option>' for value in categories)).replace('__STATUS_OPTIONS__', ''.join(f'<option>{html.escape(value)}</option>' for value in statuses))
    (output / 'report.html').write_text(page, encoding='utf-8')

    lines = [
        '# Model 素材筛选报告', '',
        f'- 来源目录：`{source}`',
        f'- 文件：{file_count:,}；目录：{len(groups):,}；包含 DAE 的目录：{len(records):,}；只有 PNG 的目录：{image_only_count:,}',
        '- 输出：`summary.json`、`models.json`、`candidates.csv`、`report.html`',
        '- 来源与许可：尚未核实；所有素材均不可仅凭本报告视作可发布资源。',
        '- 兼容与视觉：自动脚本未验证角色六槽适配、穿戴动作、营地地面锚点、实际占地或视觉质量。', '',
        '## 文件统计', '',
    ]
    lines.extend(f'- `{extension}`：{count:,}' for extension, count in summary['extension_counts'].items())
    lines.extend(['', '## 类别统计', ''])
    lines.extend(f'- {category}：{count:,}' for category, count in summary['category_counts'].items())
    lines.extend(['', '## 自动筛选结果', ''])
    lines.extend(f'- {status}：{count:,}' for status, count in summary['status_counts'].items())
    lines.extend(['', '## 判定规则', '',
        '- 目录名前缀用于生成待看类别，不作为兼容性或商品分类事实。',
        '- DAE 结构检查统计 XML 可解析性、几何、图元、控制器、蒙皮节点和图像引用。',
        '- `待人工看图` 表示类别名称匹配、存在图元网格且未发现 DAE 解析错误或缺失贴图引用。',
        '- 文件不完整、蒙皮语义、服装分区、模型尺寸、地面锚点、可摆放占地及贴图视觉效果仍须后续复核。',
        '- 运行过程仅读取源素材，所有报告写到输出目录。', '',
        '## 候选清单', '',
        '完整目录与每项检查细节见 `report.html`、`candidates.csv` 和 `models.json`。槽位线索只来自名称前缀。',
    ])
    (output / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE, help='素材库根目录')
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT, help='报告输出目录')
    options = parser.parse_args(argv)
    source = options.source.expanduser().resolve()
    output = options.output.expanduser().resolve()
    if not source.is_dir():
        parser.error(f'素材目录不存在：{source}')
    if source == output or source in output.parents:
        parser.error('报告输出目录不能位于素材目录中')
    print(f'扫描素材目录：{source}', flush=True)
    file_count, extension_counts, _, groups, images_by_name = scan_source(source)
    print(f'文件扫描完成：{file_count} 个文件，{len(groups)} 个目录', flush=True)
    records, image_only_count = build_records(source, groups, images_by_name)
    print(f'DAE 检查完成：{len(records)} 个模型目录', flush=True)
    write_outputs(source, output, file_count, extension_counts, groups, records, image_only_count)
    print(f'报告已写入：{output}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
