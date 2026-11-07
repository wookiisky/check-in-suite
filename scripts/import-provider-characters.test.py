"""KayKit预处理只写本地工作区，验证失败恢复与源文件的不可覆写边界。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'scripts/import-provider-characters.py'


# 读取交付容器中的实际JSON，而非仅检查旁边的配置。
def read_glb(path):
    data = path.read_bytes()
    assert data[:4] == b'glTF'
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


class ProviderCharacterDeliveryTest(unittest.TestCase):
    """每个来源人物必须有真实加工产物，且与标准身体使用同一个骨架。"""

    # 缩略图显隐规则变化时，即使模型字节相同也必须创建新版本。
    def test_recipe_changes_asset_version(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        covered = module.asset_version('sample', b'model', {'covers': ['scalp']})
        uncovered = module.asset_version('sample', b'model', {'covers': []})
        self.assertNotEqual(covered, uncovered)
        self.assertEqual(covered, module.asset_version('sample', b'model', {'covers': ['scalp']}))

    # 稳定人物身份可含大写，实际文件及PNG派生身份必须满足Go素材安装边界。
    def test_asset_keys_follow_installation_pattern(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        for character_key in ['kaykit-adventurers-Knight', 'kaykit-skeletons-Warrior', 'Character-' + 'x' * 140]:
            asset_key = module.asset_version(character_key, b'actual-model')
            for suffix in ['', '-thumbnail', '-hair', '-upper', '-lower', '-shoes']:
                self.assertRegex(asset_key + suffix, r'^[a-z][a-z0-9-]{0,95}$')
        self.assertEqual(module.asset_version('ASTRONAUT', b'model'), module.asset_version('astronaut', b'model'))

    # 配置中的脸发拆分必须是逐角色标注，而不是运行时猜测颜色。
    def test_sources_declare_head_selection(self):
        sources = json.loads((ROOT/'scripts/provider-character-sources.json').read_text())['sources']
        self.assertTrue(sources)
        for source in sources:
            self.assertTrue(source['head_nodes'])
            self.assertTrue(source.get('hair_uv_regions') or source.get('hair_head_above') or source.get('hair_kind'))

    # 预处理不允许恢复已退出的Kenney人物，也不再包含战损角色。
    def test_preprocessing_sources_only_include_normal_kaykit_inputs(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        configuration, base = module.preprocessing_configuration()
        self.assertTrue(configuration['sources'])
        self.assertTrue(all(source['provider'] == 'kaykit' for source in configuration['sources']))
        self.assertFalse(any(source.get('source_geometry', {}).get('battleworn_variant')
                             for source in configuration['sources']))
        self.assertEqual(base['character_key'], 'kaykit-medium-v1')

    # 统一入口使用 --output，旧 --output-directory 仍映射到同一候选参数。
    def test_output_alias_keeps_normalization_in_candidate_workspace(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module, 'import_characters', return_value=0) as build:
                self.assertEqual(module.main(['--output', directory]), 0)
                self.assertEqual(build.call_args.args[0].output_directory, Path(directory))
                self.assertIsNone(build.call_args.args[0].waist_clearance)
                module.main(['--output-directory', directory])
                self.assertEqual(build.call_args.args[0].output_directory, Path(directory))
                reference = Path(directory)/'body.glb'
                module.main(['--output', directory, '--waist-reference', str(reference), '--waist-clearance', '.034'])
                self.assertEqual(build.call_args.args[0].waist_reference, reference)
                self.assertEqual(build.call_args.args[0].waist_clearance, .034)

    # 恢复必须同时核对真实输入与已输出字节，不能只检查文件存在。
    def test_normalization_resume_requires_input_and_output_proof(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'model.glb'
            output.write_bytes(b'fixture')
            entry = {'definition': {'model_asset_key': 'model'}, 'processing_fingerprint': 'current', 'output_hashes': {'model.glb': module.hashlib.sha256(output.read_bytes()).hexdigest()}}
            self.assertTrue(module.normalization_outputs_current(entry, root, 'current'))
            self.assertFalse(module.normalization_outputs_current(entry, root, 'changed'))
            output.write_bytes(b'damaged')
            self.assertFalse(module.normalization_outputs_current(entry, root, 'current'))
            self.assertFalse(module.normalization_outputs_current({}, root, 'current'))

    # 外链及配置变化参与输入证明，不依赖 Blender 才能判定恢复条件。
    def test_normalization_fingerprint_tracks_external_dependencies(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source.gltf'
            buffer = root/'mesh.bin'
            canonical = root/'canonical.gltf'
            source.write_text(json.dumps({'buffers': [{'uri': 'mesh.bin'}]}))
            buffer.write_bytes(b'first')
            canonical.write_text('{}')
            config = {'canonical_model': str(canonical)}
            before = module.normalization_fingerprint(config, source)
            self.assertEqual(before, module.normalization_fingerprint(config, source))
            buffer.write_bytes(b'second')
            self.assertNotEqual(before, module.normalization_fingerprint(config, source))
            self.assertNotEqual(before, module.normalization_fingerprint({**config, 'scale': 2}, source))

    # 显式裸腰参考的实际字节和外链也影响恢复，不能只记录声明的sha。
    def test_normalization_fingerprint_tracks_actual_waist_reference(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, canonical, reference = [root/name for name in ['source.gltf', 'canonical.gltf', 'waist.gltf']]
            source.write_text('{}')
            canonical.write_text('{}')
            reference.write_text(json.dumps({'buffers': [{'uri':'waist.bin'}]}))
            buffer = root/'waist.bin'
            buffer.write_bytes(b'first waist')
            config = {'canonical_model':str(canonical), 'waist_reference':{'path':str(reference),'sha256':'declared'}}
            before = module.normalization_fingerprint(config, source)
            config['waist_clearance'] = .034
            self.assertNotEqual(before, module.normalization_fingerprint(config, source))
            config.pop('waist_clearance')
            buffer.write_bytes(b'changed waist')
            self.assertNotEqual(before, module.normalization_fingerprint(config, source))

    # 不用启动Blender也能核对默认输出与正式资产隔离。
    def test_default_workspace_is_local_and_does_not_reuse_production_paths(self):
        specification = importlib.util.spec_from_file_location('provider_characters', MODULE)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        self.assertEqual(module.DEFAULT_WORKSPACE, ROOT/'.local/3d-sources/modular-character-inputs')
        self.assertTrue(module.BUILTIN.is_relative_to(module.DEFAULT_WORKSPACE))
        self.assertTrue(module.MANIFEST.is_relative_to(module.DEFAULT_WORKSPACE))


@unittest.skipUnless(os.environ.get('BLENDER_PATH'), '设置 BLENDER_PATH 后验证真实 Blender CLI')
class ProviderCharacterCLITest(unittest.TestCase):
    """真实子进程只在临时仓库中加工和落盘，验证失败、恢复及只读边界。"""

    # 临时库保留一个完成项，目标人物使用真实来源及标准身体。
    def setUp(self):
        import shutil
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ['scripts', 'internal/assets/builtin', 'internal/character', '.local/3d-sources/modular-character-inputs/prepared']:
            (self.root/name).mkdir(parents=True)
        shutil.copy2(MODULE, self.root/'scripts/import-provider-characters.py')
        for name in ['asset-pipeline-candidate.py', 'provider-character-binding.py', 'provider-character-clothing-components.py']:
            shutil.copy2(ROOT/'scripts'/name, self.root/'scripts'/name)
        self.configuration = json.loads((ROOT/'scripts/provider-character-sources.json').read_text())
        self.source = self.configuration['sources'][0]
        self.configuration['sources'] = [self.source]
        self.key = self.source['key']
        self.pack_manifest = json.loads((ROOT/'internal/assets/provider-pack-manifest.json').read_text())
        for pack in self.pack_manifest['packs']:
            directory = self.root/pack['directory']
            directory.parent.mkdir(parents=True, exist_ok=True)
            directory.symlink_to(ROOT/pack['directory'], target_is_directory=True)
        canonical = self.root/self.configuration['canonical_model']
        shutil.copy2(ROOT/self.configuration['canonical_model'], canonical)
        self.workspace = self.root/'.local/3d-sources/modular-character-inputs'
        self.previous_entry = {'status': 'imported', 'definition': {'character_key': 'previous', 'model_asset_key': canonical.stem}, 'wearables': []}
        self.write('.local/3d-sources/modular-character-inputs/normalization-manifest.json', {'characters': [self.previous_entry], 'assets': [], 'complete': True, 'status': 'complete'})
        self.write('internal/assets/provider-pack-manifest.json', self.pack_manifest)
        self.write('internal/character/character-catalog.json', json.loads((ROOT/'internal/character/character-catalog.json').read_text()))
        self.write('scripts/provider-character-sources.json', self.configuration)
        shutil.copy2(canonical, self.workspace/'prepared'/canonical.name)
        self.production_paths = [self.root/'internal/character/character-catalog.json', canonical]
        self.production_before = {path: path.read_bytes() for path in self.production_paths}

    # 序列化配置和清单到独立临时库。
    def write(self, path, value):
        (self.root/path).write_text(json.dumps(value))

    # 执行交付使用的真实Blender，不以mock退出码替代CLI行为。
    def run_cli(self, *arguments):
        result = subprocess.run([os.environ['BLENDER_PATH'], '--background', '--factory-startup', '--python-exit-code', '1', '--python', str(self.root/'scripts/import-provider-characters.py'), '--', *arguments], cwd=self.root, capture_output=True, text=True, timeout=180)
        manifest = json.loads((self.workspace/'normalization-manifest.json').read_text())
        self.assertEqual(self.production_before, {path: path.read_bytes() for path in self.production_paths})
        return result, manifest

    # 失败后必须非零；修复并重试清除失败，但不能自动继承旧画面验收。
    def test_failed_character_recovers_without_losing_success_or_claiming_validation(self):
        self.source.setdefault('normalization', {})['head_envelope_verified'] = False
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key, '--force')
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['status'], 'incomplete')
        self.assertEqual(manifest['characters'], [self.previous_entry])
        self.assertEqual([item['character_key'] for item in manifest['failures']], [self.key])
        self.source['normalization']['head_envelope_verified'] = True
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(manifest['failures'], [])
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['status'], 'pending-validation')
        entries = {item['definition']['character_key']: item for item in manifest['characters']}
        self.assertEqual(entries['previous'], self.previous_entry)
        self.assertIn(self.key, entries)
        model = self.workspace/'prepared'/(entries[self.key]['definition']['model_asset_key']+'.glb')
        self.assertEqual(read_glb(model)['asset']['version'], '2.0')

    # 同身份同字节允许重用，GLB或PNG已有不同字节时都失败并保留原文件。
    def test_existing_model_and_thumbnail_versions_are_immutable(self):
        self.source.setdefault('normalization', {})['head_envelope_verified'] = True
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key, '--force')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        entry = next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key)
        directory = self.workspace/'prepared'
        paths = [directory/(entry['definition']['model_asset_key']+'.glb'), directory/(entry['definition']['thumbnail_asset_key']+'.png')]
        before = {path: path.read_bytes() for path in paths}
        result, _ = self.run_cli('--only', self.key, '--force')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(before, {path: path.read_bytes() for path in paths})
        for path in paths:
            with self.subTest(resource=path.suffix):
                path.write_bytes(b'different existing version')
                result, manifest = self.run_cli('--only', self.key, '--force')
                self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
                self.assertEqual(path.read_bytes(), b'different existing version')
                self.assertFalse(manifest['complete'])
                self.assertEqual(entry, next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key))
                path.write_bytes(before[path])

    # 缺失模型、人物图或服装图时，本次普通恢复直接重建，无需第二次force。
    def test_missing_deliveries_are_rebuilt_without_force(self):
        self.source.setdefault('normalization', {})['head_envelope_verified'] = True
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        entry = next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key)
        directory = self.workspace/'prepared'
        paths = [directory/(entry['definition']['model_asset_key']+'.glb'), directory/(entry['definition']['thumbnail_asset_key']+'.png'), directory/(entry['wearables'][0]['thumbnail_asset_key']+'.png')]
        before = {path: path.read_bytes() for path in paths}
        for path in paths:
            with self.subTest(resource=path.name):
                manifest.update(complete=True, status='complete')
                self.write('.local/3d-sources/modular-character-inputs/normalization-manifest.json', manifest)
                path.unlink()
                result, manifest = self.run_cli('--only', self.key)
                self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                self.assertTrue(path.exists())
                self.assertTrue(all(path.read_bytes() == content for path, content in before.items()))
                self.assertFalse(manifest['complete'])
                self.assertEqual(manifest['status'], 'pending-validation')
                self.assertEqual(manifest['failures'], [])
                self.assertEqual(entry, next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key))
        paths[0].unlink()
        self.source['normalization']['head_envelope_verified'] = False
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key)
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['status'], 'incomplete')
        self.assertFalse(paths[0].exists())
        self.assertEqual(paths[1].read_bytes(), before[paths[1]])
        self.assertEqual(entry, next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key))

    # 分批失败不能清空没有选择的失败记录，已有成果也继续保留。
    def test_partial_retry_preserves_unselected_failures(self):
        self.configuration['sources'] = [{'key': key, 'normalization': {'head_envelope_verified': False}} for key in ['first', 'second']]
        self.write('scripts/provider-character-sources.json', self.configuration)
        for key in ['first', 'second']:
            result, manifest = self.run_cli('--only', key)
            self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual({item['character_key'] for item in manifest['failures']}, {'first', 'second'})
        self.assertEqual(manifest['characters'], [self.previous_entry])

    # 从实际制作生成依赖与产物证明，跳过时保留验收，重加工后重新待验收。
    def test_skipping_completed_sources_preserves_validation(self):
        self.source.setdefault('normalization', {})['head_envelope_verified'] = True
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        entry = next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key)
        self.assertTrue(entry['processing_fingerprint'])
        self.assertTrue(entry['output_hashes'])
        before = {name: (self.workspace/'prepared'/name).read_bytes() for name in entry['output_hashes']}
        manifest.update(complete=True, status='complete')
        self.write('.local/3d-sources/modular-character-inputs/normalization-manifest.json', manifest)
        result, skipped = self.run_cli('--only', self.key)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertTrue(skipped['complete'])
        self.assertEqual(skipped['status'], 'complete')
        self.assertEqual(manifest, skipped)
        self.assertEqual(before, {name: (self.workspace/'prepared'/name).read_bytes() for name in before})
        # 强制重新制作会令旧画面验收失效，即使生成的字节相同。
        result, rebuilt = self.run_cli('--only', self.key, '--force')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertFalse(rebuilt['complete'])
        self.assertEqual(rebuilt['status'], 'pending-validation')
        self.assertEqual(before, {name: (self.workspace/'prepared'/name).read_bytes() for name in before})

    # 拼错选择范围必须失败，且不能改写旧清单或目录。
    def test_unknown_only_is_nonzero_and_preserves_manifests(self):
        paths = [self.workspace/'normalization-manifest.json', self.root/'internal/character/character-catalog.json']
        before = {path: path.read_bytes() for path in paths}
        result, _ = self.run_cli('--only', 'unknown-character')
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(before, {path: path.read_bytes() for path in paths})


if __name__ == '__main__':
    unittest.main()
