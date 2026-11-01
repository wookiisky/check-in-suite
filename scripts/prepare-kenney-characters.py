"""在独立本地工作区试加工Kenney人物，不写正式资源和验收状态。"""
import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


# 未通过画面验收的源仅在独立配置中放行，正式配置保持待验证。
def prepare_workspace(root, workspace, only):
    configuration = json.loads((root / 'scripts/kenney-character-sources.json').read_text())
    sources = {source['key']: source for source in configuration['sources']}
    unknown = set(only) - sources.keys()
    if unknown:
        raise ValueError('unknown character source: ' + ', '.join(sorted(unknown)))
    if workspace == root or root.is_relative_to(workspace):
        raise ValueError('preparation workspace must be separate from the source root')
    selected = list(dict.fromkeys(only or sources))
    scripts = workspace / 'scripts'
    scripts.mkdir(parents=True, exist_ok=True)
    for source in (root / 'scripts').glob('*.py'):
        target = scripts / source.name
        if not target.exists():
            target.symlink_to(source)
    for name in ['kenney-character-heads.json', 'kenney-mini-heads.json', 'kenney-extra-heads.json']:
        source = root / 'scripts' / name
        if source.exists():
            shutil.copy2(source, scripts / name)
    staged = copy.deepcopy(configuration)
    staged['sources'] = []
    staged['preparation_only'] = True
    for key in selected:
        source = copy.deepcopy(sources[key])
        profile = configuration['profiles'][source['profile']]
        source['normalization'] = {**profile['normalization'], **source.get('normalization', {}), 'head_envelope_verified': True}
        staged['sources'].append(source)
    (scripts / 'kenney-character-sources.json').write_text(json.dumps(staged, ensure_ascii=False, indent=2) + '\n')
    canonical = json.loads((root / 'scripts/provider-character-sources.json').read_text())
    canonical['sources'] = []
    (scripts / 'provider-character-sources.json').write_text(json.dumps(canonical, ensure_ascii=False, indent=2) + '\n')
    (scripts / 'legacy-kaykit-character-sources.json').write_text('{"sources": []}\n')
    builtin = workspace / 'internal/assets/builtin'
    builtin.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / canonical['canonical_model'], workspace / canonical['canonical_model'])
    shutil.copy2(root / 'internal/assets/provider-pack-manifest.json', workspace / 'internal/assets/provider-pack-manifest.json')
    catalog = workspace / 'internal/character/character-catalog.json'
    catalog.parent.mkdir(parents=True, exist_ok=True)
    current = json.loads((root / 'internal/character/character-catalog.json').read_text())
    if catalog.exists():
        previous = json.loads(catalog.read_text())
        existing_characters = {item['character_key'] for item in current['characters']}
        existing_wearables = {item['wearable_key'] for item in current['wearables']}
        current['characters'].extend(item for item in previous['characters'] if item['character_key'] in sources and item['character_key'] not in existing_characters)
        current['wearables'].extend(item for item in previous['wearables'] if item['character_key'] in sources and item['wearable_key'] not in existing_wearables)
    catalog.write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n')
    for relative in ['.local/3d-sources/provider-packs', '.local/3d-sources/character-inspection']:
        link = workspace / relative
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.exists():
            link.symlink_to(root / relative, target_is_directory=True)
    return selected


# Blender单独进程使用暂存根，源脚本保持可复用且不改当前图形界面。
def run_blender(workspace, only, evidence):
    import importlib.util
    specification = importlib.util.spec_from_file_location('provider_import', ROOT / 'scripts/import-provider-characters.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    module.ROOT = workspace
    module.BUILTIN = workspace / 'internal/assets/builtin'
    module.MANIFEST = workspace / 'internal/assets/provider-character-manifest.json'
    module.CONFIGURATION = workspace / 'scripts/provider-character-sources.json'
    module.import_characters(argparse.Namespace(only=only, force=True, evidence=evidence, evidence_output=workspace / '.local/3d-sources/provider-character-work/evidence'))
    result = json.loads(module.MANIFEST.read_text())
    result.update(status='preparation-only', complete=False)
    module.MANIFEST.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if result.get('failures'):
        raise RuntimeError('Kenney preparation failed: ' + json.dumps(result['failures'], ensure_ascii=False))


# 默认只生成指定样例；全量需显式选择--all，避免误拼身份触发大批加工。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', action='append', default=[])
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--workspace', type=Path, default=ROOT / '.local/kenney-characters/workspace')
    parser.add_argument('--blender', default='/Applications/Blender.app/Contents/MacOS/Blender')
    parser.add_argument('--evidence', action='store_true')
    parser.add_argument('--inside-blender', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None)
    workspace = args.workspace.resolve()
    if args.inside_blender:
        run_blender(workspace, args.only, args.evidence)
        return
    if not args.only and not args.all:
        parser.error('select --only CHARACTER_KEY or --all')
    selected = prepare_workspace(ROOT, workspace, args.only)
    command = [args.blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python', str(Path(__file__).resolve()), '--', '--inside-blender', '--workspace', str(workspace)]
    for key in selected:
        command.extend(['--only', key])
    if args.evidence:
        command.append('--evidence')
    subprocess.run(command, check=True)


if __name__ == '__main__':
    main()
