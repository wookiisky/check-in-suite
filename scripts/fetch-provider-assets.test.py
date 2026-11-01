"""验证官方目录、免费文件筛选与原包解压边界。"""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('provider_fetch', Path(__file__).with_name('fetch-provider-assets.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderFetchTest(unittest.TestCase):
    # 分类页可以重复展示同一包，但不能把分类导航当作素材包。
    def test_catalog_filters_navigation_and_duplicates(self):
        markup = "<a href='https://kenney.nl/assets/nature-kit'>A</a><a href='https://kenney.nl/assets/nature-kit'>B</a><a href='https://kenney.nl/assets/category:3D'>3D</a>"
        self.assertEqual(MODULE.catalog_urls(markup, 'kenney'), ['https://kenney.nl/assets/nature-kit'])

    # 下载页中的锁定文件没有下载按钮，不应尝试获得其上传文件。
    def test_only_accessible_itch_uploads_are_selected(self):
        markup = '<div class="upload"><a class="button download_btn" data-upload_id="15363167">Download</a><div><strong class="name">Free 2.0</strong></div></div><div class="upload"><div><strong class="name">Extra 2.0</strong></div></div>'
        self.assertEqual(MODULE.itch_uploads(markup), [{'id': '15363167', 'name': 'Free 2.0'}])

    # 源包按真实模型格式统计，不把预览图或贴图计为模型。
    def test_archive_extraction_and_model_count(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('Models/scene.GLTF', '{}')
            archive.writestr('Models/scene.bin', b'')
            archive.writestr('Models/texture.png', b'')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'archive.zip'
            source.write_bytes(data.getvalue())
            MODULE.extract_archive(source, root / 'extracted')
            self.assertEqual(MODULE.model_formats(root / 'extracted'), {'.gltf': 1})

    # 官方目录失常时，原包也不能越过其专用输出目录。
    def test_archive_rejects_parent_paths(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('../escape.txt', 'x')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'archive.zip'
            source.write_bytes(data.getvalue())
            with self.assertRaises(ValueError):
                MODULE.extract_archive(source, root / 'extracted')
            self.assertFalse((root / 'escape.txt').exists())


if __name__ == '__main__':
    unittest.main()
