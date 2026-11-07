"""候选预览只处理已声明子集，保留正式定义与初始依赖。"""
from io import BytesIO
from PIL import Image
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

image = BytesIO()
Image.new('RGBA', (2, 2), (10, 20, 30, 255)).save(image, format='PNG')
PNG = image.getvalue()


# 工具模块不依赖Blender，几何与渲染在各测试中替换。
def load(name, filename):
    specification = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class TinyTreatsPreviewStageTest(unittest.TestCase):
    """通过真实candidate与runtime目录验证stage的文件和引用契约。"""

    # 所有路径在临时仓库，正式文件保留哨兵以发现越界写入。
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)/'root'
        self.output = self.root/'.local/candidate'
        self.module = load('tiny_preview_test', 'render-tiny-treats-previews.py')
        self.helper = load('tiny_helper_test', 'asset-pipeline-candidate.py')
        self.pipeline = load('tiny_pipeline_test', 'asset-pipeline.py')
        self.root.joinpath('internal/island').mkdir(parents=True)
        self.write(self.root/'internal/island/spatial-houses.json', {'houses': [{'house_key': 'retained', 'note': 'preserve'}], 'catalog': []})
        self.write(self.root/'internal/island/spatial-scenes.json', [{'scene_key': 'retained', 'note': 'preserve', 'scene': {'note': 'preserve'}}])
        self.write(self.root/'internal/assets/builtin/catalog.json', [])
        self.baseline = self.helper.capture_baseline(self.root)
        self.calls = []
        self.renderer = types.SimpleNamespace(render_settings=lambda value: value, render_model=lambda job, settings: self.calls.append(job))

    # 写入实际JSON以便核心检查遍历正式目录契约。
    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    # 基础候选包含具体房屋或景物，不默认纳入整个素材配置。
    def candidate(self, with_house=True, scenes=()):
        models = self.output/'internal/assets/builtin'
        models.mkdir(parents=True)
        manifest = {'houses': [], 'assets': [], 'scene_keys': list(scenes)}
        if with_house:
            variant = self.module.CONTENT['houses'][0]
            key = variant['house_key']
            model = models/(key+'.glb')
            model.write_bytes(b'fixture-model')
            manifest['houses'].append({'house_key': key, 'model_url': '/api/v1/assets/'+key, 'footprint': {'width_cm': 600, 'depth_cm': 660}})
            manifest['assets'].append({'key': key, 'name': variant['name'], 'kind': 'model', 'format': 'glb', 'url': '/api/v1/assets/'+key, 'license': 'fixture'})
        self.write(models/'catalog.json', manifest['assets'])
        self.write(self.output/'internal/assets/tiny-treats-manifest.json', manifest)
        self.helper.finalize_candidate(self.root, self.output, 'tiny-treats', baseline=self.baseline, dependencies=[Path(__file__)])
        return manifest

    # 渲染替身只生成真实PNG样本，既不导入模型也不调用Blender。
    def thumbnail(self, renderer, model, output):
        output.write_bytes(PNG)

    # 仅一套房屋时只产生该房屋的缩略图及四向剖墙，不扩展其他房屋或场景。
    def test_selected_house_updates_runtime_and_content_versioned_thumbnail(self):
        original = self.candidate()
        official = (self.root/'internal/island/spatial-houses.json').read_bytes()
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'renderer_module', return_value=self.renderer), patch.object(self.module, 'model_thumbnail', side_effect=self.thumbnail), patch.object(self.module, 'scene_preview_model', side_effect=AssertionError('unexpected scene')):
            self.module.main(['--output', str(self.output)])
        self.assertEqual(len(self.calls), 4)
        self.assertEqual((self.root/'internal/island/spatial-houses.json').read_bytes(), official)
        houses = json.loads((self.output/'internal/island/spatial-houses.json').read_text())
        self.assertEqual(houses['houses'][0]['note'], 'preserve')
        house = houses['houses'][1]
        self.assertTrue(house['thumbnail_asset_key'].startswith(house['house_key']+'-thumbnail-'))
        self.assertEqual(houses['catalog'][0]['thumbnail_asset_key'], house['thumbnail_asset_key'])
        manifest = self.pipeline.verify_candidate(self.root, self.output)
        self.pipeline.check_integrity(self.root, self.output, manifest)
        self.assertTrue(all(item in manifest['baseline'] for item in [{'path': 'internal/assets/builtin/catalog.json', 'sha256': self.baseline['internal/assets/builtin/catalog.json']}]))
        self.assertEqual(manifest['states']['checks'], 'not_run')

    # 明确选中的场景缺景物时记录缺口，绝不自动重新加工或扩充来源。
    def test_missing_scene_assets_remain_explicit_gap(self):
        scene = {'scene_key': 'selected-scene', 'landscape': [{'asset_key': 'missing-tree'}]}
        self.candidate(False, ['selected-scene'])
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'SCENES', [scene]), patch.object(self.module, 'renderer_module', return_value=self.renderer), patch.object(self.module, 'model_thumbnail', side_effect=AssertionError('unexpected render')):
            self.module.main(['--directory', str(self.output)])
        manifest = json.loads((self.output/'internal/assets/tiny-treats-manifest.json').read_text())
        self.assertEqual(manifest['preview_gaps'], [{'scene_key': 'selected-scene', 'missing_assets': ['missing-tree']}])
        self.assertEqual(manifest['scenes'], [])
        candidate = json.loads((self.output/'candidate.json').read_text())
        self.assertEqual(candidate['states']['processing'], 'pending')
        self.assertFalse(list((self.output/'internal/assets/builtin').glob('*.glb')))

    # 仅更新明确选择的场景，保留既有wrapper和scene额外字段。
    def test_scene_runtime_merge_preserves_wrapper_and_nested_fields(self):
        source = {'scene_key': 'selected-scene', 'name': '测试场景', 'default_environment': 'day', 'environments': ['day'], 'regions': [], 'spawn': {'x_cm': 0, 'z_cm': 0}, 'landscape': []}
        scenes_path = self.root/'internal/island/spatial-scenes.json'
        self.write(scenes_path, [{'scene_key': 'selected-scene', 'custom': 'keep-top', 'free': True, 'scene': {'custom': 'keep-scene', 'activity_presentations': {'read': {'fixture': True}}}}])
        self.baseline = self.helper.capture_baseline(self.root)
        self.candidate(False, ['selected-scene'])
        def overview(scene, directory, output):
            output.write_bytes(b'local-overview')
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'SCENES', [source]), patch.object(self.module, 'renderer_module', return_value=self.renderer), patch.object(self.module, 'model_thumbnail', side_effect=self.thumbnail), patch.object(self.module, 'scene_preview_model', side_effect=overview):
            self.module.main(['--output', str(self.output)])
        result = json.loads((self.output/'internal/island/spatial-scenes.json').read_text())[0]
        self.assertEqual(result['custom'], 'keep-top')
        self.assertEqual(result['scene']['custom'], 'keep-scene')
        self.assertTrue(result['free'])
        self.assertIn('read', result['scene']['activity_presentations'])
        self.assertTrue(result['thumbnail_asset_key'].startswith('selected-scene-thumbnail-'))
        manifest = self.pipeline.verify_candidate(self.root, self.output)
        self.pipeline.check_integrity(self.root, self.output, manifest)

    # 第一张缩略图完成后第二张剖墙失败，原候选仍完整，重试无需再做几何。
    def test_second_render_failure_can_retry_preview_stage(self):
        self.candidate()
        before = (self.output/'candidate.json').read_bytes()
        failing = types.SimpleNamespace(render_settings=lambda value: value, render_model=lambda job, settings: (_ for _ in ()).throw(RuntimeError('second image failed')))
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'renderer_module', return_value=failing), patch.object(self.module, 'model_thumbnail', side_effect=self.thumbnail):
            with self.assertRaisesRegex(RuntimeError, 'second image failed'):
                self.module.main(['--output', str(self.output)])
        self.assertEqual((self.output/'candidate.json').read_bytes(), before)
        self.assertFalse(list((self.output/'internal/assets/builtin').glob('*.png')))
        self.pipeline.verify_candidate(self.root, self.output)
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'renderer_module', return_value=self.renderer), patch.object(self.module, 'model_thumbnail', side_effect=self.thumbnail):
            self.module.main(['--output', str(self.output)])
        self.pipeline.verify_candidate(self.root, self.output)

    # 图像渲染失败时原有候选仍可验证，不把半张图片计入交付。
    def test_render_failure_preserves_original_candidate(self):
        self.candidate()
        before = (self.output/'candidate.json').read_bytes()
        with patch.object(self.module, 'ROOT', self.root), patch.object(self.module, 'renderer_module', return_value=self.renderer), patch.object(self.module, 'model_thumbnail', side_effect=RuntimeError('render failure')):
            with self.assertRaisesRegex(RuntimeError, 'render failure'):
                self.module.main(['--output', str(self.output)])
        self.assertEqual((self.output/'candidate.json').read_bytes(), before)
        self.pipeline.verify_candidate(self.root, self.output)


if __name__ == '__main__':
    unittest.main()
