"""用隔离目录验证候选不会覆盖正式产物，并拒绝遗漏或变化的依赖。"""
import hashlib
import importlib.util
import json
import struct
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('asset-pipeline-candidate.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


# 所有检查只使用临时样本，不读取项目实际素材。
class CandidateManifestTest(unittest.TestCase):
    # 仅正式旧目录与候选新目录的差集声明退役，其他源码文件不受影响。
    def test_retirement_lists_only_old_registered_resource_difference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            old = root/'internal/assets/builtin'
            new = output/'internal/assets/builtin'
            old.mkdir(parents=True)
            new.mkdir(parents=True)
            (old/'retired.glb').write_bytes(b'old GLB')
            (old/'shared.svg').write_bytes(b'<svg/>')
            (old/'unregistered.png').write_bytes(b'not registered')
            (old/'reused-assets.json').write_text('{}')
            (old/'catalog.json').write_text(json.dumps([{'key': 'retired', 'format': 'glb'}, {'key': 'shared'}]))
            (new/'catalog.json').write_text(json.dumps([{'key': 'shared'}]))
            result = MODULE.finalize_candidate(root, output, 'provider', baseline=MODULE.capture_baseline(root))
            self.assertEqual([{'path': 'internal/assets/builtin/retired.glb', 'sha256': hashlib.sha256(b'old GLB').hexdigest()}], result['retired_source_files'])
            self.assertEqual(b'old GLB', (old/'retired.glb').read_bytes())

    # 目录或待退役字节在加工中变化，均不能把新指纹当作构建前基线。
    def test_retirement_rejects_build_time_catalog_or_resource_drift(self):
        for drift in ['catalog', 'resource']:
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as temporary:
                root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
                old = root/'internal/assets/builtin'
                new = output/'internal/assets/builtin'
                old.mkdir(parents=True)
                new.mkdir(parents=True)
                (old/'retired.glb').write_bytes(b'old')
                (old/'catalog.json').write_text('[{"key":"retired","format":"glb"}]')
                (new/'catalog.json').write_text('[]')
                baseline = MODULE.capture_baseline(root)
                (old/('catalog.json' if drift == 'catalog' else 'retired.glb')).write_text('[]' if drift == 'catalog' else 'changed')
                with self.assertRaisesRegex(ValueError, 'changed during build'):
                    MODULE.finalize_candidate(root, output, 'provider', baseline=baseline)

    # 当前候选明确生成或复用的资源不能同时退役。
    def test_retirement_rejects_generated_or_reused_overlap(self):
        for collision in ['generated', 'reused']:
            with self.subTest(collision=collision), tempfile.TemporaryDirectory() as temporary:
                root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
                old = root/'internal/assets/builtin'
                new = output/'internal/assets/builtin'
                old.mkdir(parents=True)
                new.mkdir(parents=True)
                (old/'retired.glb').write_bytes(b'old')
                (old/'catalog.json').write_text('[{"key":"retired","format":"glb"}]')
                (new/'catalog.json').write_text('[]')
                if collision == 'generated':
                    (new/'retired.glb').write_bytes(b'old')
                reuse = ['internal/assets/builtin/retired.glb'] if collision == 'reused' else []
                with self.assertRaisesRegex(ValueError, 'retired.*current'):
                    MODULE.finalize_candidate(root, output, 'provider', baseline=MODULE.capture_baseline(root), reused_paths=reuse)

    # 退役路径即使链接到同目录的当前资源也必须拒绝，不能在应用时解析并误删目标。
    def test_retirement_rejects_symlink_to_current_resource(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            old = root/'internal/assets/builtin'
            new = output/'internal/assets/builtin'
            old.mkdir(parents=True)
            new.mkdir(parents=True)
            current = old/'current.glb'
            current.write_bytes(b'current registered resource')
            (old/'retired.glb').symlink_to(current.name)
            (old/'catalog.json').write_text('[{"key":"retired","format":"glb"},{"key":"current","format":"glb"}]')
            (new/'catalog.json').write_text('[{"key":"current","format":"glb"}]')
            with self.assertRaisesRegex(ValueError, 'retirement.*symlink'):
                MODULE.finalize_candidate(root, output, 'provider', baseline=MODULE.capture_baseline(root))
            self.assertEqual(b'current registered resource', current.read_bytes())
            self.assertTrue((old/'retired.glb').is_symlink())

    # 整理目录中的复用资源绑定源字节，变化时不能继续生成成功报告。
    def test_reuse_drift_and_missing_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            formal = root/'internal/assets/builtin'
            formal.mkdir(parents=True)
            source = formal/'shared.glb'
            source.write_bytes(b'old')
            baseline = MODULE.capture_baseline(root)
            catalog = output/'internal/assets/builtin/catalog.json'
            catalog.parent.mkdir(parents=True)
            catalog.write_text(json.dumps([{'key': 'shared', 'format': 'glb'}]))
            source.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'changed during build'):
                MODULE.finalize_candidate(root, output, 'static', baseline=baseline)
            source.unlink()
            with self.assertRaises(FileNotFoundError):
                MODULE.finalize_candidate(root, output, 'static', baseline=baseline)
            self.assertFalse((output/'candidate.json').exists())

    # 依赖在加工中变化时拒绝把新指纹写入旧产物的候选报告。
    def test_dependencies_are_captured_before_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            root.mkdir()
            recipe = root/'recipe.json'
            recipe.write_bytes(b'old recipe')
            dependencies = MODULE.capture_dependencies(root, [recipe])
            recipe.write_bytes(b'new recipe')
            with self.assertRaisesRegex(ValueError, 'dependency changed during build'):
                MODULE.finalize_candidate(root, output, 'characters', baseline={}, dependencies=dependencies)

    # 不把外部软链接当作候选镜像文件交给后续应用步骤。
    def test_generated_symlink_cannot_escape_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            (output/'internal').mkdir(parents=True)
            external = Path(temporary)/'external.json'
            external.write_bytes(b'outside')
            (output/'internal/catalog.json').symlink_to(external)
            with self.assertRaisesRegex(ValueError, 'candidate file escapes'):
                MODULE.finalize_candidate(root, output, 'static', baseline={})

    # 失败的加工批次仍可保留候选报告，但不能声称自动检查已通过。
    def test_failed_processing_stays_distinct_from_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            result = MODULE.finalize_candidate(root, output, 'animation', baseline={}, processing='failed')
            self.assertIn('python', result['tool_versions'])
            self.assertEqual(result['states']['processing'], 'failed')
            self.assertEqual(result['states']['checks'], 'not_run')
            self.assertEqual(result['states']['application_checks'], 'not_run')

    # 编排器重新整理清单时保留实际制作进程的版本。
    def test_orchestrator_preserves_adapter_tool_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            versions = {'python': 'Blender bundled Python', 'blender': '5.2.3', 'orchestrator_python': 'CLI Python'}
            result = MODULE.finalize_candidate(root, output, 'characters', baseline={}, tool_versions=versions)
            self.assertEqual(result['tool_versions'], versions)
            self.assertEqual(versions['python'], 'Blender bundled Python')

    # 历史图标没有format时沿用运行时的SVG默认，不修改目录元数据。
    def test_legacy_icon_without_format_reuses_svg(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            builtin = root/'internal/assets/builtin'
            builtin.mkdir(parents=True)
            (builtin/'legacy-icon.svg').write_bytes(b'<svg/>')
            baseline = MODULE.capture_baseline(root)
            catalog = output/'internal/assets/builtin/catalog.json'
            catalog.parent.mkdir(parents=True)
            original = [{'key': 'legacy-icon', 'kind': 'icon'}]
            catalog.write_text(json.dumps(original))
            result = MODULE.finalize_candidate(root, output, 'resources', baseline=baseline)
            self.assertEqual(result['reused'], [{'path': 'internal/assets/builtin/legacy-icon.svg', 'sha256': hashlib.sha256(b'<svg/>').hexdigest()}])
            self.assertEqual(json.loads(catalog.read_text()), original)

    # 未重新生成的运行目录也属于候选的输入，期间变更必须阻断。
    def test_unmodified_runtime_catalog_is_bound_to_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary)/'repo', Path(temporary)/'candidate'
            rules = root/'scripts/asset-pipeline-rules.json'
            rules.parent.mkdir(parents=True)
            rules.write_text(json.dumps({'runtime_catalogs': ['internal/character/catalog.json']}))
            catalog = root/'internal/character/catalog.json'
            catalog.parent.mkdir(parents=True)
            catalog.write_bytes(b'old catalog')
            baseline = MODULE.capture_baseline(root)
            result = MODULE.finalize_candidate(root, output, 'resources', baseline=baseline)
            self.assertIn('internal/character/catalog.json', [entry['path'] for entry in result['reused']])
            catalog.write_bytes(b'new catalog')
            with self.assertRaisesRegex(ValueError, 'changed during build'):
                MODULE.finalize_candidate(root, output, 'resources', baseline=baseline)
            with self.assertRaisesRegex(ValueError, 'changed during build'):
                MODULE.finalize_candidate(root, output, 'resources', baseline={})


# 依赖枚举读取容器声明，不能仅凭主文件指纹跳过外链贴图变化。
class CandidateSourceDependenciesTest(unittest.TestCase):
    # GLTF和GLB都应枚举真实外链，data URI留在源文件哈希内。
    def test_gltf_and_glb_external_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            document = {'buffers': [{'uri': 'mesh.bin'}], 'images': [{'uri': 'skin%20color.png'}, {'uri': 'data:image/png;base64,AA=='}]}
            for name in ['mesh.bin', 'skin color.png']:
                (root/name).write_bytes(name.encode())
            gltf = root/'model.gltf'
            gltf.write_text(json.dumps(document))
            self.assertEqual(set(MODULE.source_dependencies(gltf)), {gltf, root/'mesh.bin', root/'skin color.png'})
            content = json.dumps(document).encode()
            content += b' ' * (-len(content) % 4)
            glb = root/'model.glb'
            glb.write_bytes(struct.pack('<III', 0x46546C67, 2, 20+len(content))+struct.pack('<II', len(content), 0x4E4F534A)+content)
            self.assertEqual(set(MODULE.source_dependencies(glb)), {glb, root/'mesh.bin', root/'skin color.png'})

    # 缺少外链在捕获指纹时报告，不执行网络下载弥补来源缺失。
    def test_remote_dependencies_are_rejected_and_missing_remain_visible(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)/'model.gltf'
            source.write_text(json.dumps({'images': [{'uri': 'missing.png'}]}))
            with self.assertRaises(FileNotFoundError):
                MODULE.capture_dependencies(Path(temporary), MODULE.source_dependencies(source))
            source.write_text(json.dumps({'images': [{'uri': 'https://example.com/image.png'}]}))
            with self.assertRaisesRegex(ValueError, 'non-local source dependency'):
                MODULE.source_dependencies(source)


if __name__ == '__main__':
    unittest.main()
