"""使用真实子进程、PNG 与临时文件检查批量预览的缓存和恢复。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/preview-gltf-assets.py'


# 每个用例拥有自己的输入、输出及替身进程，不接触正式素材。
class PreviewBatchTest(unittest.TestCase):
    # 为实际 CLI 建立隔离的模型和可执行渲染器。
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.model = self.directory / 'chair.glb'
        self.model.write_bytes(b'fixture-model')
        self.output = self.directory / 'previews'
        self.blender = self.directory / 'blender'
        fixture = ROOT / 'scripts/preview-gltf-test-blender.py'
        self.blender.write_text('#!' + sys.executable + '\n' + fixture.read_text())
        self.blender.chmod(0o755)

    # 从真实命令入口执行，并读取本次输出清单。
    def run_preview(self, *arguments):
        result = subprocess.run([sys.executable, str(SCRIPT), '--input', str(self.model), '--output', str(self.output), '--blender', str(self.blender), '--size', '64', *arguments], text=True, capture_output=True)
        manifest = self.output / 'preview-manifest.json'
        return result, json.loads(manifest.read_text()) if manifest.exists() else None

    # 首次渲染和第二次复用必须生成可解码图片，并保持输入字节。
    def test_first_render_then_cache_without_changing_input(self):
        before = self.model.read_bytes()
        result, manifest = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest['summary'], {'rendered': 1, 'cached': 0, 'failed': 0})
        self.assertEqual(len(manifest['items'][0]['files']), 4)
        with Image.open(manifest['sheets'][0]) as image:
            self.assertGreater(image.width, 64)
        result, manifest = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest['summary'], {'rendered': 0, 'cached': 1, 'failed': 0})
        self.assertEqual(self.model.read_bytes(), before)

    # 源模型、预览尺寸和强制刷新分别使对应缓存失效。
    def test_source_settings_and_force_invalidate_cache(self):
        self.assertEqual(self.run_preview()[0].returncode, 0)
        self.model.write_bytes(b'changed-fixture-model')
        self.assertEqual(self.run_preview()[1]['summary']['rendered'], 1)
        self.assertEqual(self.run_preview('--size', '80')[1]['summary']['rendered'], 1)
        self.assertEqual(self.run_preview('--size', '80', '--force')[1]['summary']['rendered'], 1)

    # 缺图或改图不能继续被报告为缓存命中。
    def test_missing_and_corrupt_image_are_rendered_again(self):
        _, manifest = self.run_preview()
        Path(manifest['items'][0]['files'][0]).unlink()
        self.assertEqual(self.run_preview()[1]['summary']['rendered'], 1)
        Path(manifest['items'][0]['files'][1]).write_bytes(b'invalid-png')
        self.assertEqual(self.run_preview()[1]['summary']['rendered'], 1)

    # 部分失败保留成功结果，修复输入后只重试失败项。
    def test_partial_failure_then_recovery(self):
        failed = self.directory / 'broken.glb'
        failed.write_bytes(b'FAIL')
        result, manifest = self.run_preview('--input', str(failed))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(manifest['summary'], {'rendered': 1, 'cached': 0, 'failed': 1})
        failed.write_bytes(b'repaired')
        result, manifest = self.run_preview('--input', str(failed))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest['summary'], {'rendered': 1, 'cached': 1, 'failed': 0})

    # 不存在的输入和空目录应明确失败，不能伪装完成。
    def test_missing_input_and_empty_directory(self):
        result, manifest = self.run_preview('--input', str(self.directory / 'missing.glb'))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(manifest['summary']['failed'], 1)
        empty = self.directory / 'empty'
        empty.mkdir()
        self.model.unlink()
        result = subprocess.run([sys.executable, str(SCRIPT), '--input', str(empty), '--blender', str(self.blender)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    # 同一模型重复传入或同时从目录发现时只渲染一次。
    def test_duplicate_inputs_are_deduplicated(self):
        result, manifest = self.run_preview('--input', str(self.directory))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(manifest['items']), 1)

    # 切换筛选范围后返回原范围，仍复用此前已完成的模型。
    def test_cache_survives_narrower_input_selection(self):
        second = self.directory / 'table.glb'
        second.write_bytes(b'table')
        self.assertEqual(self.run_preview('--input', str(second))[1]['summary']['rendered'], 2)
        self.assertEqual(self.run_preview()[1]['summary']['cached'], 1)
        self.assertEqual(self.run_preview('--input', str(second))[1]['summary']['cached'], 2)

    # 缓存记录损坏后可以自动重建，不把损坏文件当作成功证据。
    def test_corrupt_cache_is_rebuilt(self):
        self.assertEqual(self.run_preview()[0].returncode, 0)
        (self.output / 'preview-cache.json').write_text('not-json')
        result, manifest = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest['summary']['rendered'], 1)


# 人物预览必须使用已有覆盖规则，防止同时渲染多套衣服。
class CharacterPreviewSelectionTest(unittest.TestCase):
    # 动态加载有连字符的工具文件，不依赖项目发布包。
    def test_default_outfit_hides_covered_body_regions(self):
        spec = importlib.util.spec_from_file_location('preview_assets', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        character = {'fixed_nodes': ['head', 'hands'], 'body_regions': {'torso': ['body'], 'scalp': ['scalp']}, 'defaults': {'upper': 'shirt'}}
        wearables = {'shirt': {'nodes': ['shirt_mesh'], 'covers': ['torso']}}
        self.assertEqual(module.character_visible_nodes(character, wearables), ['head', 'hands', 'scalp', 'shirt_mesh'])


if __name__ == '__main__':
    unittest.main()
