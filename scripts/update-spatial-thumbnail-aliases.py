"""从明确的历史资源记录生成营地缩略图别名，不推断名称或文件名前缀。"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


# 原始记录、曾发布身份与之前加工版本均显式关联到同一个稳定物件。
def historical_thumbnail_pairs(document):
    for item in document.get('items', []):
        key = item.get('item_key')
        if not key:
            continue
        for field in ('thumbnail_asset_key', 'published_thumbnail_asset_key'):
            if item.get(field):
                yield item[field], key
        for previous in item.get('previous_library_versions', []):
            if previous.get('thumbnail_asset_key'):
                yield previous['thumbnail_asset_key'], key
    for item in document.get('definitions', []):
        yield item['thumbnail_asset_key'], item['item_key']


# 保留已登记的历史关系；只输出当前仍有能力定义且已经换版的物件。
def build_aliases(current, previous, sources):
    aliases = dict(previous.get('aliases', {}))
    evidence = {json.dumps(source, sort_keys=True): source for source in previous.get('sources', [])}
    for source, data in sources:
        entry = {'source': source, 'sha256': hashlib.sha256(data).hexdigest()}
        evidence[json.dumps(entry, sort_keys=True)] = entry
        for thumbnail, key in historical_thumbnail_pairs(json.loads(data)):
            if key not in current or thumbnail == current[key]:
                continue
            if thumbnail in aliases and aliases[thumbnail] != key:
                raise ValueError(f'conflicting spatial thumbnail identity: {thumbnail}')
            aliases[thumbnail] = key
    aliases = {thumbnail: key for thumbnail, key in aliases.items() if key in current and thumbnail != current[key]}
    return {'sources': sorted(evidence.values(), key=lambda source: (source['source'], source['sha256'])), 'aliases': dict(sorted(aliases.items()))}


# Git blob 仅作为制作期输入，运行包只包含紧凑映射及来源校验信息。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'internal/assets/provider-asset-manifest.json')
    parser.add_argument('--history', type=Path, action='append', default=[])
    parser.add_argument('--history-git-blob', action='append', default=[])
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/island/spatial-scene.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'internal/island/spatial-thumbnail-aliases.json')
    options = parser.parse_args()
    current = {item['item_key']: item['thumbnail_asset_key'] for item in json.loads(options.catalog.read_text())['catalog']}
    previous = json.loads(options.output.read_text()) if options.output.exists() else {}
    paths = [options.manifest, *options.history]
    sources = [(str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path), path.read_bytes()) for path in paths]
    sources.extend((f'git-blob:{oid}', subprocess.check_output(['git', 'cat-file', 'blob', oid], cwd=ROOT)) for oid in options.history_git_blob)
    result = build_aliases(current, previous, sources)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print('历史缩略图映射已更新', len(result['aliases']), options.output)


if __name__ == '__main__':
    main()
