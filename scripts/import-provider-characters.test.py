"""人物加工在真实 GLB 上校验骨架、四槽与脸发分离；不使用模拟网格证明兼容。"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'scripts/import-provider-characters.py'


# 读取交付容器中的实际JSON，而非仅检查旁边的配置。
def read_glb(path):
    import struct
    data = path.read_bytes()
    assert data[:4] == b'glTF'
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


# 从实际顶点缓冲计算固定脸范围，防止完整头皮留在无法被发型覆盖的网格里。
def mesh_bounds(path, name):
    data = path.read_bytes()
    document = read_glb(path)
    length = struct.unpack_from('<I', data, 12)[0]
    binary = data[28+length:]
    names = {name} if isinstance(name, str) else set(name)
    points = []
    for node in document['nodes']:
        if node.get('name') not in names:
            continue
        for primitive in document['meshes'][node['mesh']]['primitives']:
            accessor = document['accessors'][primitive['attributes']['POSITION']]
            view = document['bufferViews'][accessor['bufferView']]
            start = view.get('byteOffset', 0)+accessor.get('byteOffset', 0)
            points.extend(struct.unpack_from('<fff', binary, start+i*view.get('byteStride', 12))
                          for i in range(accessor['count']))
    return [(min(point[axis] for point in points), max(point[axis] for point in points)) for axis in range(3)]


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
        for character_key in ['kenney-space-kit-astronautA', 'kenney-space-kit-astronautB', 'Character-' + 'x' * 140]:
            asset_key = module.asset_version(character_key, b'actual-model')
            for suffix in ['', '-thumbnail', '-hair', '-upper', '-lower', '-shoes']:
                self.assertRegex(asset_key + suffix, r'^[a-z][a-z0-9-]{0,95}$')
        self.assertEqual(module.asset_version('ASTRONAUT', b'model'), module.asset_version('astronaut', b'model'))

    # 配置中的脸发拆分必须是逐角色标注，而不是运行时猜测颜色。
    def test_sources_declare_head_selection(self):
        sources = json.loads((ROOT/'scripts/provider-character-sources.json').read_text())['sources']
        self.assertGreaterEqual(len(sources), 10)
        for source in sources:
            self.assertTrue(source['head_nodes'])
            self.assertTrue(source.get('hair_uv_regions') or source.get('hair_head_above') or source.get('hair_kind'))

    # 同源多格式不产生重复人物，每个导入角色必须交付共用身体与全部四槽。
    def test_actual_delivered_characters(self):
        manifest = json.loads((ROOT/'internal/assets/provider-character-manifest.json').read_text())
        entries = manifest['characters']
        self.assertGreaterEqual(len(entries), 10)
        keys = set()
        for entry in entries:
            self.assertEqual(entry['status'], 'imported', entry)
            definition = entry['definition']
            self.assertNotIn(definition['character_key'], keys)
            keys.add(definition['character_key'])
            self.assertEqual(definition['body_key'], 'kaykit-medium-body-v1')
            self.assertLess(entry['binding_error'], 0.00001)
            self.assertEqual(set(definition['defaults']), {'hair','upper','lower','shoes'})
            document = read_glb(ROOT/'internal/assets/builtin'/(definition['model_asset_key']+'.glb'))
            names = {node.get('name') for node in document['nodes'] if 'mesh' in node}
            self.assertIn('body_head', names)
            self.assertIn('body_hands', names)
            for wearable in entry['wearables']:
                self.assertTrue(set(wearable['nodes']) <= names)
                self.assertEqual(wearable['body_key'], definition['body_key'])
                self.assertEqual(wearable['rig_key'], definition['rig_key'])
            self.assertTrue(entry['face_hair_disjoint'])

    # 曾穿出共用发型的完整头壳必须分区，完整脸和头皮共同遵守标准头部包络。
    def test_bald_heads_partition_standard_head_envelope(self):
        directory = ROOT/'internal/assets/builtin'
        canonical = mesh_bounds(directory/'character-medium-v1.glb', 'body_head')
        envelope = mesh_bounds(directory/'character-medium-v1.glb', ['body_head', 'body_scalp'])
        manifest = json.loads((ROOT/'internal/assets/provider-character-manifest.json').read_text())
        keys = {'kaykit-adventurers-barbarian', 'kaykit-skeletons-mage', 'kaykit-skeletons-minion',
                'kaykit-skeletons-rogue', 'kaykit-skeletons-warrior'}
        entries = {entry['definition']['character_key']: entry for entry in manifest['characters']}
        self.assertTrue(keys <= entries.keys())
        for key in sorted(keys):
            with self.subTest(character=key):
                definition = entries[key]['definition']
                model = directory/(definition['model_asset_key']+'.glb')
                bounds = mesh_bounds(model, 'body_head')
                self.assertLessEqual(bounds[1][1], canonical[1][1]+0.00001)
                self.assertGreater(bounds[1][1]-bounds[1][0], 0.5)
                actual = mesh_bounds(model, ['body_head', 'body_scalp'])
                for standard_axis, actual_axis in zip(envelope, actual):
                    self.assertGreaterEqual(actual_axis[0], standard_axis[0]-0.00001)
                    self.assertLessEqual(actual_axis[1], standard_axis[1]+0.00001)
                document = read_glb(model)
                head = next(node for node in document['nodes'] if node.get('name') == 'body_head')
                materials = {document['materials'][primitive['material']]['name'].split('.')[0]
                             for primitive in document['meshes'][head['mesh']]['primitives']}
                if key.startswith('kaykit-skeletons-'):
                    self.assertIn('Glow', materials, '眼睛必须留在固定脸中')

    # 在真实 Blender 中只检查指定人物，且证据加工不能改写正式交付文件。
    @unittest.skipUnless(os.environ.get('BLENDER_PATH'), '设置 BLENDER_PATH 后执行真实 Blender 小样')
    def test_evidence_sample_preserves_delivery(self):
        manifest = json.loads((ROOT/'internal/assets/provider-character-manifest.json').read_text())
        key = manifest['characters'][0]['definition']['character_key']
        paths = [ROOT/'internal/character/character-catalog.json',
                 ROOT/'internal/assets/provider-character-manifest.json',
                 *sorted((ROOT/'internal/assets/builtin').glob('*'))]
        before = {path: hashlib.sha256(path.read_bytes()).digest() for path in paths if path.is_file()}
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([os.environ['BLENDER_PATH'], '--background', '--factory-startup',
                                     '--python', str(MODULE), '--', '--evidence', '--only', key,
                                     '--evidence-output', directory], cwd=ROOT,
                                    capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout+'\n'+result.stderr)
            self.assertEqual(sorted(path.name for path in Path(directory).glob('*.png')),
                             [key+'-shared-outfit.png', key+'-source.png'])
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).digest() for path in before})


@unittest.skipUnless(os.environ.get('BLENDER_PATH'), '设置 BLENDER_PATH 后验证真实 Blender CLI')
class ProviderCharacterCLITest(unittest.TestCase):
    """真实子进程只在临时仓库中加工和落盘，验证失败、恢复及只读边界。"""

    # 临时库保留一个完成项，目标人物使用真实来源及标准身体。
    def setUp(self):
        import shutil
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ['scripts', 'internal/assets/builtin', 'internal/character']:
            (self.root/name).mkdir(parents=True)
        shutil.copy2(MODULE, self.root/'scripts/import-provider-characters.py')
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
        self.previous_entry = {'status': 'imported', 'definition': {'character_key': 'previous', 'model_asset_key': canonical.stem}, 'wearables': []}
        self.write('internal/assets/provider-character-manifest.json', {'characters': [self.previous_entry], 'assets': [], 'complete': True, 'status': 'complete'})
        self.write('internal/assets/provider-pack-manifest.json', self.pack_manifest)
        self.write('internal/character/character-catalog.json', json.loads((ROOT/'internal/character/character-catalog.json').read_text()))
        self.write('scripts/provider-character-sources.json', self.configuration)

    # 序列化配置和清单到独立临时库。
    def write(self, path, value):
        (self.root/path).write_text(json.dumps(value))

    # 执行交付使用的真实Blender，不以mock退出码替代CLI行为。
    def run_cli(self, *arguments):
        result = subprocess.run([os.environ['BLENDER_PATH'], '--background', '--factory-startup', '--python-exit-code', '1', '--python', str(self.root/'scripts/import-provider-characters.py'), '--', *arguments], cwd=self.root, capture_output=True, text=True, timeout=180)
        manifest = json.loads((self.root/'internal/assets/provider-character-manifest.json').read_text())
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
        model = self.root/'internal/assets/builtin'/(entries[self.key]['definition']['model_asset_key']+'.glb')
        self.assertEqual(read_glb(model)['asset']['version'], '2.0')

    # 同身份同字节允许重用，GLB或PNG已有不同字节时都失败并保留原文件。
    def test_existing_model_and_thumbnail_versions_are_immutable(self):
        self.source.setdefault('normalization', {})['head_envelope_verified'] = True
        self.write('scripts/provider-character-sources.json', self.configuration)
        result, manifest = self.run_cli('--only', self.key, '--force')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        entry = next(item for item in manifest['characters'] if item['definition']['character_key'] == self.key)
        directory = self.root/'internal/assets/builtin'
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
        directory = self.root/'internal/assets/builtin'
        paths = [directory/(entry['definition']['model_asset_key']+'.glb'), directory/(entry['definition']['thumbnail_asset_key']+'.png'), directory/(entry['wearables'][0]['thumbnail_asset_key']+'.png')]
        before = {path: path.read_bytes() for path in paths}
        for path in paths:
            with self.subTest(resource=path.name):
                manifest.update(complete=True, status='complete')
                self.write('internal/assets/provider-character-manifest.json', manifest)
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

    # 没有实际重加工时可以保留此前明确完成的状态和有效字节。
    def test_skipping_completed_sources_preserves_validation(self):
        self.configuration['sources'] = [{'key': 'previous'}]
        self.write('scripts/provider-character-sources.json', self.configuration)
        canonical = self.root/self.configuration['canonical_model']
        before = canonical.read_bytes()
        result, manifest = self.run_cli('--only', 'previous')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['status'], 'complete')
        self.assertEqual(canonical.read_bytes(), before)

    # 拼错选择范围必须失败，且不能改写旧清单或目录。
    def test_unknown_only_is_nonzero_and_preserves_manifests(self):
        paths = [self.root/'internal/assets/provider-character-manifest.json', self.root/'internal/character/character-catalog.json']
        before = {path: path.read_bytes() for path in paths}
        result, _ = self.run_cli('--only', 'unknown-character')
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(before, {path: path.read_bytes() for path in paths})


if __name__ == '__main__':
    unittest.main()
