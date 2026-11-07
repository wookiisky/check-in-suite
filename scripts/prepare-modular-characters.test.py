"""不依赖 Blender 的不可变发布与来源解剖色块检查。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('prepare_modular', Path(__file__).with_name('prepare-modular-characters.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


# 发布身份包含字节与完整元数据，任何一个变化都不能覆写已交付身份。
class ImmutableModularPublicationTest(unittest.TestCase):
    # 同像素但名称或许可改变，也需要新资源身份。
    def test_metadata_changes_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = MODULE.BUILTIN
            MODULE.BUILTIN = Path(temporary)
            try:
                metadata = dict(name='原名称', kind='wearable', provider='kaykit', license='CC0-1.0', pack_key='adventurers')
                original = MODULE.publish(b'same pixels', 'png', 'preview', metadata)
                self.assertEqual(original, MODULE.publish(b'same pixels', 'png', 'preview', dict(reversed(list(metadata.items())))))
                renamed = MODULE.publish(b'same pixels', 'png', 'preview', {**metadata, 'name': '新名称'})
                changed_license = MODULE.publish(b'same pixels', 'png', 'preview', {**metadata, 'license': 'other'})
                self.assertEqual(3, len({original, renamed, changed_license}))
                self.assertEqual(b'same pixels', (Path(temporary) / (original + '.png')).read_bytes())
                self.assertNotEqual(original, MODULE.publish(b'new pixels', 'png', 'preview', metadata))
            finally:
                MODULE.BUILTIN = previous

    # 旧配方遇到变化的原文件或标准化输入必须在发布前拒绝。
    def test_changed_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'source.glb').write_bytes(b'original')
            declaration = {'path': 'source.glb', 'sha256': hashlib.sha256(b'original').hexdigest()}
            configuration = {'canonical_input': declaration, 'arrow_input': declaration, 'sources': []}
            self.assertEqual({'source.glb': declaration['sha256']}, MODULE.verify_inputs(configuration, root))
            (root / 'source.glb').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'source checksum mismatch: source.glb'):
                MODULE.verify_inputs(configuration, root)

    # 手部原包和共同蒙皮参考都参与输入核对，不能只验证基础身体来源。
    def test_changed_hand_or_skinning_reference_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            declarations = {}
            for name in ['canonical.glb', 'hands.glb', 'skinning.glb', 'bare-hands.glb']:
                (root / name).write_bytes(name.encode())
                declarations[name] = {'path': name, 'sha256': hashlib.sha256(name.encode()).hexdigest()}
            configuration = {
                'canonical_input': declarations['canonical.glb'],
                'arrow_input': declarations['canonical.glb'],
                'sources': [],
                'canonical_hand_sources': {'upper': declarations['hands.glb']},
                'human_body_shape': {
                    'arm_skinning_reference': declarations['skinning.glb'],
                    'hand_surface_reference': declarations['bare-hands.glb'],
                },
            }
            self.assertEqual(set(declarations), set(MODULE.verify_inputs(configuration, root)))
            for name in ['hands.glb', 'skinning.glb', 'bare-hands.glb']:
                with self.subTest(reference=name):
                    (root / name).write_bytes(b'changed reference')
                    with self.assertRaisesRegex(ValueError, 'source checksum mismatch: ' + name):
                        MODULE.verify_inputs(configuration, root)
                    (root / name).write_bytes(name.encode())

    # 模拟真实文件发布中途失败，旧目录、清单和资源字节必须完整保留。
    def test_failed_publication_restores_previous_delivery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / 'staging'
            destination = root / 'builtin'
            staging.mkdir()
            destination.mkdir()
            (staging / 'first.glb').write_bytes(b'new model')
            (staging / 'second.png').write_bytes(b'new picture')
            catalog = destination / 'catalog.json'
            manifest = root / 'manifest.json'
            catalog.write_bytes(b'old catalog')
            manifest.write_bytes(b'old manifest')
            (destination / 'previous.glb').write_bytes(b'old model')
            before = {path: path.read_bytes() for path in [catalog, manifest, destination / 'previous.glb']}
            real_copy = MODULE.shutil.copyfile

            # 首个产物已写入后，让第二个产物的真实写入失败。
            def fail_second(source, target):
                if source.name == 'second.png':
                    raise OSError('injected publication failure')
                return real_copy(source, target)

            with mock.patch.object(MODULE.shutil, 'copyfile', side_effect=fail_second):
                with self.assertRaisesRegex(OSError, 'injected publication failure'):
                    MODULE.commit_outputs(staging, destination, {catalog: b'new catalog', manifest: b'new manifest'}, ['previous.glb'])
            self.assertEqual(before, {path: path.read_bytes() for path in before})
            self.assertEqual({'catalog.json', 'previous.glb'}, {path.name for path in destination.iterdir()})
            MODULE.commit_outputs(staging, destination, {catalog: b'new catalog', manifest: b'new manifest'}, ['previous.glb'])
            self.assertEqual(b'new catalog', catalog.read_bytes())
            self.assertFalse((destination / 'previous.glb').exists())
            self.assertEqual({'catalog.json', 'first.glb', 'second.png'}, {path.name for path in destination.iterdir()})

    # 语义来自已审核源UV/材质，白色衣物不靠颜色近似误删。
    def test_anatomical_surfaces_use_source_atlas(self):
        self.assertTrue(MODULE.body_surface('kaykit-skeletons-minion', 'skeleton', (.18, .6)))
        self.assertFalse(MODULE.body_surface('kaykit-skeletons-minion', 'skeleton', (.8, .6)))
        self.assertTrue(MODULE.body_surface('kaykit-adventurers-barbarian', 'barbarian', (.05, .85)))
        self.assertFalse(MODULE.body_surface('kaykit-adventurers-barbarian', 'barbarian', (.18, .1)))
        self.assertTrue(MODULE.body_surface('kaykit-legacy-skeleton-minion', 'White.001', (.5, .5)))
        self.assertFalse(MODULE.body_surface('kaykit-legacy-skeleton-warrior', 'Stone', (.5, .5)))


# 候选制作只输出镜像目录，正式文件和复用资源保持原字节。
class ModularCandidateOutputTest(unittest.TestCase):
    # 新模型与目录隔离写入，未生成资源须以实际哈希显式登记复用。
    def test_candidate_output_preserves_formal_and_declares_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'repo'
            builtin = root/'internal/assets/builtin'
            builtin.mkdir(parents=True)
            (builtin/'motion.glb').write_bytes(b'existing motion')
            (builtin/'legacy-icon.svg').write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"/>')
            (builtin/'empty-format.svg').write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"/>')
            catalog = root/'internal/character/character-catalog.json'
            catalog.parent.mkdir(parents=True)
            catalog.write_bytes(b'old catalog')
            staging = Path(temporary)/'staging'
            staging.mkdir()
            (staging/'body.glb').write_bytes(b'new body')
            candidate = Path(temporary)/'candidate'
            manifest = MODULE.write_candidate(staging, candidate, {catalog: b'new catalog'},
                                              [{'key': 'motion', 'format': 'glb'}, {'key': 'legacy-icon'}, {'key': 'empty-format', 'format': ''}], root)
            self.assertEqual(catalog.read_bytes(), b'old catalog')
            self.assertFalse((builtin/'body.glb').exists())
            self.assertEqual((candidate/'internal/assets/builtin/body.glb').read_bytes(), b'new body')
            self.assertEqual((candidate/'internal/character/character-catalog.json').read_bytes(), b'new catalog')
            declaration = json.loads((candidate/'internal/assets/builtin/reused-assets.json').read_text())
            self.assertEqual(declaration['motion.glb'], hashlib.sha256(b'existing motion').hexdigest())
            self.assertEqual(declaration['legacy-icon.svg'], hashlib.sha256((builtin/'legacy-icon.svg').read_bytes()).hexdigest())
            self.assertEqual(declaration['empty-format.svg'], hashlib.sha256((builtin/'empty-format.svg').read_bytes()).hexdigest())
            self.assertEqual(manifest['states']['checks'], 'not_run')
            self.assertEqual(manifest['states']['promotion'], 'not_run')
            self.assertEqual({item['path']: item['sha256'] for item in manifest['baseline']}['internal/character/character-catalog.json'], hashlib.sha256(b'old catalog').hexdigest())

    # 输出不能覆盖源码目录，即使暂存为空也应在导入 Blender 前失败。
    def test_output_rejects_repository_production_paths(self):
        for output in [MODULE.ROOT, MODULE.ROOT/'internal', MODULE.ROOT/'scripts', MODULE.ROOT/'web/public/models']:
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, 'candidate output'):
                MODULE.candidate_output(output)


if __name__ == '__main__':
    unittest.main()
