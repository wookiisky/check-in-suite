"""用隔离源和渲染替身验证营地制作入口，不依赖Blender或实际素材。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


class CampCandidateTests(unittest.TestCase):
    """正式目录只读，模型、图片与元数据只写候选。"""

    # 加载入口只提供Blender导入替身，不实现任何真实加工。
    def load_module(self):
        path = Path(__file__).with_name('prepare-camp-assets.py')
        specification = importlib.util.spec_from_file_location('camp_candidate_test', path)
        module = importlib.util.module_from_spec(specification)
        with patch.dict('sys.modules', {'bpy': types.SimpleNamespace(), 'mathutils': types.SimpleNamespace(Vector=None, Matrix=None)}):
            specification.loader.exec_module(module)
        return module

    # 真实main处理目录合并与候选清单，渲染只产生临时测试字节。
    def test_main_isolates_catalog_and_metadata(self):
        module = self.load_module()
        with tempfile.TemporaryDirectory() as directory:
            root, output = Path(directory)/'root', Path(directory)/'candidate'
            builtin = root/'internal/assets/builtin'
            builtin.mkdir(parents=True)
            catalog = builtin/'catalog.json'
            catalog.write_text('[]\n')
            configuration = root/'internal/assets/camp-source-manifest.json'
            configuration.write_text(json.dumps({'items': [], 'extra_assets': [], 'house_thumbnail': {'key': 'house', 'kind': 'island'}}))
            def thumbnail(config):
                path = module.BUILTIN/'house.png'
                path.write_bytes(b'fixture-image')
                return {'key': config['key']}
            with patch.object(module, 'ROOT', root), patch.object(module, 'house_thumbnail', side_effect=thumbnail):
                module.main(['--output', str(output)])
            self.assertEqual(catalog.read_text(), '[]\n')
            self.assertFalse((root/'internal/assets/camp-asset-metadata.json').exists())
            self.assertTrue((output/'internal/assets/camp-asset-metadata.json').exists())
            manifest = json.loads((output/'candidate.json').read_text())
            self.assertEqual(manifest['pipeline'], 'camp')
            self.assertEqual(manifest['states']['checks'], 'not_run')
            self.assertTrue(any(item['path'].endswith('house.png') for item in manifest['generated']))

    # 许可来源与读书姿势虽不在模型字节内，也参与加工依赖。
    def test_source_metadata_path_matches_pack(self):
        module = self.load_module()
        part = {'source': '.local/3d-sources/kenney-furniture/Models/chair.glb'}
        self.assertEqual(module.source_metadata_path(part), module.ROOT/'.local/3d-sources/kenney-furniture/source.json')

    # 在启动加工或创建目录之前拒绝正式目标。
    def test_rejects_official_output_before_rendering(self):
        module = self.load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(module, 'ROOT', root), patch.object(module, 'house_thumbnail', side_effect=AssertionError('rendered')):
                with self.assertRaises(ValueError):
                    module.main(['--output', str(root/'internal')])
            self.assertFalse((root/'internal').exists())


if __name__ == '__main__':
    unittest.main()
