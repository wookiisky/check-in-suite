"""验证实际 glTF 容器、世界边界与独立摆设选择。"""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('provider_assets', Path(__file__).with_name('import-provider-assets.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderStaticImportTest(unittest.TestCase):
    # 外链缓冲与图片都必须写入交付 GLB，而不是留下源目录依赖。
    def test_external_gltf_is_embedded_and_grounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            positions = struct.pack('<9f', 0, -1, 0, 2, -1, 0, 0, 3, 4)
            (root / 'mesh.bin').write_bytes(positions)
            (root / 'texture.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            document = {'asset': {'version': '2.0'}, 'buffers': [{'uri': 'mesh.bin', 'byteLength': len(positions)}], 'bufferViews': [{'buffer': 0, 'byteLength': len(positions)}], 'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}], 'images': [{'uri': 'texture.png'}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'nodes': [{'mesh': 0, 'translation': [2, 0, 1]}], 'scenes': [{'nodes': [0]}], 'scene': 0}
            source = root / 'model.gltf'
            source.write_text(json.dumps(document))
            target = root / 'result.glb'
            result = MODULE.prepare_gltf(source, target, max_extent=4)
            baked, binary = MODULE.read_gltf(target)
            self.assertEqual(result['bounds_m'], [[-1, 1], [0, 4], [-2, 2]])
            self.assertFalse(any('uri' in buffer for buffer in baked['buffers']))
            self.assertFalse(any('uri' in image for image in baked['images']))
            self.assertEqual(baked['images'][0]['mimeType'], 'image/png')
            self.assertIn(b'\x89PNG', binary)
            self.assertEqual(struct.unpack_from('<I', target.read_bytes(), 8)[0], target.stat().st_size)

    # 单墙片等零件必须经过明确审核排除，不能因为有模型就自动售卖。
    def test_selection_requires_explicit_model_decision(self):
        policy = {'include': ['chair'], 'exclude': {'wall': 'building-component'}}
        self.assertEqual(MODULE.model_decision('chair', policy), ('included', None))
        self.assertEqual(MODULE.model_decision('wall', policy), ('excluded', 'building-component'))
        self.assertEqual(MODULE.model_decision('unknown', policy), ('pending-review', 'model-not-reviewed'))

    # 不同源格式是同一个候选，独立命名的配色仍是不同候选。
    def test_discovery_prefers_gltf_without_dropping_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['GLB/chair.gltf.glb', 'FBX/chair.fbx', 'GLTF/chair-red.gltf', 'OBJ/chair-red.obj']:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            models = MODULE.discover_models(root)
            self.assertEqual({item['model_id'] for item in models}, {'chair', 'chair-red'})
            self.assertEqual({Path(item['source']).suffix for item in models}, {'.glb', '.gltf'})

    # 官方旧导出可能保留未引用父节点，包装地面锚点不能让同一节点出现两个父级。
    def test_unreachable_export_parent_is_not_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'mesh.bin').write_bytes(struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 1))
            document = {'asset': {'version': '2.0'}, 'buffers': [{'uri': 'mesh.bin', 'byteLength': 36}], 'bufferViews': [{'buffer': 0, 'byteLength': 36}], 'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'nodes': [{'name': 'unusedExportParent', 'children': [1]}, {'mesh': 0}], 'scenes': [{'nodes': [1]}], 'scene': 0}
            source = root / 'model.gltf'
            source.write_text(json.dumps(document))
            MODULE.prepare_gltf(source, root / 'result.glb')
            result, _ = MODULE.read_gltf(root / 'result.glb')
            parents = {}
            for node in result['nodes']:
                for child in node.get('children', []):
                    parents[child] = parents.get(child, 0) + 1
            self.assertTrue(all(count == 1 for count in parents.values()))

    # 官方方向后缀仍指向同一个模型，不能误判为没有真实缩略图。
    def test_official_directional_thumbnail_matches_exact_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'Isometric').mkdir()
            image = root / 'Isometric' / 'tree_NE.png'
            image.touch()
            self.assertEqual(MODULE.official_thumbnail(root, 'tree'), image)
            self.assertIsNone(MODULE.official_thumbnail(root, 'tree-large'))

    # 精选必须引用已完成的完整物件，重复引用不能挤占本次数量。
    def test_selection_rejects_duplicates_and_unprepared_models(self):
        records = [{'provider': 'kenney', 'pack_key': 'nature-kit', 'model_id': 'tree', 'status': 'prepared'}]
        item = {'provider': 'kenney', 'pack_key': 'nature-kit', 'model_id': 'tree'}
        chosen = MODULE.validate_selection(records, {'target_count': 1, 'items': [item]})
        self.assertEqual(len(chosen), 1)
        with self.assertRaises(ValueError):
            MODULE.validate_selection(records, {'target_count': 2, 'items': [item, item]})
        with self.assertRaises(ValueError):
            MODULE.validate_selection(records, {'target_count': 1, 'items': [{**item, 'model_id': 'unknown'}]})

    # 清理未交付中间版本时，人物资源、原有资源和最终摆设均须保留。
    def test_pruning_only_removes_owned_intermediate_static_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            previous_root = MODULE.ROOT
            MODULE.ROOT = Path(directory)
            try:
                builtin = MODULE.ROOT / 'internal/assets/builtin'
                builtin.mkdir(parents=True)
                keys = ['camp-bed-v1', 'kaykit-knight-m-123456789abc', 'kenney-nature-tree-abcdef-12345678', 'kenney-nature-tree-abcdef-87654321']
                for key in keys:
                    (builtin / (key + '.glb')).write_bytes(b'fixture')
                (builtin / 'catalog.json').write_text(json.dumps([{'key': key} for key in keys]))
                MODULE.prune_generated_versions({keys[-1]})
                self.assertEqual({item['key'] for item in json.loads((builtin / 'catalog.json').read_text())}, set(keys[:2] + keys[-1:]))
                self.assertFalse((builtin / (keys[-2] + '.glb')).exists())
                self.assertTrue((builtin / (keys[0] + '.glb')).exists())
            finally:
                MODULE.ROOT = previous_root

    # 已安装的版本标识不能被不同模型字节覆盖。
    def test_existing_version_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'version.glb'
            MODULE.write_immutable(target, b'original')
            MODULE.write_immutable(target, b'original')
            with self.assertRaises(ValueError):
                MODULE.write_immutable(target, b'changed')


# 缓存的判断依据是真实源依赖与交付字节，不能把文件存在当作已完成。
class ProviderStaticCacheTest(unittest.TestCase):
    # 小三角形提供实际 buffer 和图片依赖，用于检查重建后的 GLB 内容。
    def make_source(self, root, binary_container=False):
        positions = struct.pack('<9f', 0, -1, 0, 2, -1, 0, 0, 3, 4)
        (root / 'mesh.bin').write_bytes(positions)
        (root / 'texture.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        document = {'asset': {'version': '2.0'}, 'buffers': [{'uri': 'mesh.bin', 'byteLength': len(positions)}], 'bufferViews': [{'buffer': 0, 'byteLength': len(positions)}], 'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}], 'images': [{'uri': 'texture.png'}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0}
        source = root / ('model.glb' if binary_container else 'model.gltf')
        if binary_container:
            source.write_bytes(MODULE.glb_bytes(document, b''))
        else:
            source.write_text(json.dumps(document))
        return source

    # 第二次须跳过加工，且第一次的交付字节和 metadata 与无缓存路径一致。
    def test_cache_reuses_verified_output_without_changing_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.make_source(root)
            target = root / 'cached.glb'
            expected = MODULE.prepare_gltf(source, root / 'uncached.glb')
            with patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                first = MODULE.prepare_gltf_cached(source, target)
                second = MODULE.prepare_gltf_cached(source, target)
                self.assertEqual(prepare.call_count, 1)
            self.assertEqual(first, expected)
            self.assertEqual(second, expected)
            self.assertEqual(target.read_bytes(), (root / 'uncached.glb').read_bytes())

    # 实际清单导入重复执行也使用缓存，商品身份和占地仍由同一产物生成。
    def test_record_import_reuses_preparation_without_changing_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_source(root)
            (root / 'Isometric').mkdir()
            (root / 'Isometric/model.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            record = {'source': 'model.gltf', 'provider': 'kenney', 'pack_key': 'test-pack', 'pack_name': 'Test Pack',
                      'model_id': 'model', 'directory': '.', 'status': 'included', 'source_url': 'https://example.test/model', 'license': 'CC0-1.0'}
            policy = {'packs': {'kenney/test-pack': {'names': {'model': 'Test model'}}}}
            with patch.object(MODULE, 'ROOT', root), patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                first_record, second_record = dict(record), dict(record)
                first = MODULE.import_records([first_record], policy)
                second = MODULE.import_records([second_record], policy)
                self.assertEqual(prepare.call_count, 1)
            self.assertEqual(first, second)
            self.assertEqual(first_record, second_record)
            self.assertEqual(first_record['status'], 'prepared')

    # 参数、源描述或加工代码变化都必须重建，不能复用旧边界与模型。
    def test_cache_invalidates_source_parameters_and_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.make_source(root)
            target = root / 'cached.glb'
            with patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                MODULE.prepare_gltf_cached(source, target)
                MODULE.prepare_gltf_cached(source, target, max_extent=2)
                MODULE.prepare_gltf_cached(source, target, max_extent=2, source_scale=.25)
                document = json.loads(source.read_text())
                document['nodes'][0]['translation'] = [1, 0, 0]
                source.write_text(json.dumps(document))
                MODULE.prepare_gltf_cached(source, target, max_extent=2, source_scale=.25)
                with patch.object(MODULE, 'STATIC_PIPELINE_SHA256', 'changed-pipeline'):
                    MODULE.prepare_gltf_cached(source, target, max_extent=2, source_scale=.25)
                self.assertEqual(prepare.call_count, 5)

    # GLB 同样允许外链；两个容器的外链 buffer 与图片改变都必须重建。
    def test_external_buffers_and_images_invalidate_both_container_formats(self):
        for binary_container in (False, True):
            with self.subTest(binary_container=binary_container), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.make_source(root, binary_container)
                target = root / 'cached.glb'
                with patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                    initial = MODULE.prepare_gltf_cached(source, target)
                    (root / 'mesh.bin').write_bytes(struct.pack('<9f', 0, -1, 0, 3, -1, 0, 0, 3, 4))
                    changed = MODULE.prepare_gltf_cached(source, target)
                    self.assertNotEqual(initial['model_sha256'], changed['model_sha256'])
                    (root / 'texture.png').write_bytes(b'\x89PNG\r\n\x1a\nchanged-image')
                    textured = MODULE.prepare_gltf_cached(source, target)
                    self.assertNotEqual(changed['model_sha256'], textured['model_sha256'])
                    self.assertEqual(prepare.call_count, 3)

    # 文件丢失或被截断时重建；失败不能留下可命中的成功缓存。
    def test_missing_corrupt_output_and_failed_build_are_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.make_source(root)
            target = root / 'cached.glb'
            expected = MODULE.prepare_gltf_cached(source, target)
            with patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                target.unlink()
                self.assertEqual(MODULE.prepare_gltf_cached(source, target), expected)
                target.write_bytes(b'broken')
                self.assertEqual(MODULE.prepare_gltf_cached(source, target), expected)
                target.with_suffix('.cache.json').write_text('{broken')
                self.assertEqual(MODULE.prepare_gltf_cached(source, target), expected)
                cache_path = target.with_suffix('.cache.json')
                cache = json.loads(cache_path.read_text())
                cache['metadata']['scale'] = 123
                cache_path.write_text(json.dumps(cache))
                self.assertEqual(MODULE.prepare_gltf_cached(source, target), expected)
                self.assertEqual(prepare.call_count, 4)
            with patch.object(MODULE, 'prepare_gltf', side_effect=ValueError('test-build-failure')):
                with self.assertRaises(ValueError):
                    MODULE.prepare_gltf_cached(source, target, max_extent=1)
            with patch.object(MODULE, 'prepare_gltf', wraps=MODULE.prepare_gltf) as prepare:
                changed = MODULE.prepare_gltf_cached(source, target, max_extent=1)
                self.assertEqual(MODULE.prepare_gltf_cached(source, target, max_extent=1), changed)
                self.assertEqual(prepare.call_count, 1)


class ProviderSelectedScaleTest(unittest.TestCase):
    # 用实际床模型证明一米多的原始家具在两倍适配后能容纳标准人物，且占地一致变化。
    def test_selected_scale_updates_real_bed_and_preserves_unselected_library(self):
        original_bed = MODULE.ROOT / 'internal/assets/builtin/camp-bed-v1.glb'
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, 'ROOT', Path(directory)):
            root = Path(directory)
            library = root / '.local/3d-sources/provider-prepared/library'
            library.mkdir(parents=True)
            source = library / 'bed-source.glb'
            metadata = MODULE.prepare_gltf(original_bed, source, source_scale=.5)
            thumbnail = library / 'bed-source-thumb.png'
            thumbnail.write_bytes(b'unchanged-uniform-projection')
            record = {'provider': 'kenney', 'pack_key': 'furniture-kit', 'model_id': 'bedDouble', 'status': 'prepared', 'item_key': 'bed', 'model_asset_key': 'bed-source', 'thumbnail_asset_key': 'bed-source-thumb', **metadata, 'scale': 1, 'thumbnail_sha256': 'unused'}
            untouched = {'provider': 'kenney', 'pack_key': 'furniture-kit', 'model_id': 'chair', 'status': 'prepared', 'item_key': 'untouched'}
            records = [record, untouched.copy()]
            assets = [{'key': 'bed-source', 'kind': 'model', 'format': 'glb', 'url': '/api/v1/assets/bed-source'}, {'key': 'bed-source-thumb', 'kind': 'island', 'format': 'png', 'url': '/api/v1/assets/bed-source-thumb'}]
            definitions = [{'item_key': 'bed', 'footprint': {'width_cm': 58, 'depth_cm': 113}, 'walk_obstacle': {'width_cm': 58, 'depth_cm': 113}, 'model_url': '/api/v1/assets/bed-source', 'thumbnail_asset_key': 'bed-source-thumb'}]
            configuration = {'target_count': 1, 'items': [{'provider': 'kenney', 'pack_key': 'furniture-kit', 'model_id': 'bedDouble', 'source_scale': 2, 'scale_reason': '沿用原有家具与标准人物的比例', 'reason': '沿用原有家具', 'name': '双人床', 'category': 'furniture', 'coin_price': 50, 'spaces': ['indoor']}]}
            previous = source.read_bytes()
            MODULE.resize_selection(records, assets, definitions, configuration)
            result = library / (record['model_asset_key'] + '.glb')
            document, binary = MODULE.read_gltf(result)
            bounds = MODULE.scene_bounds(document, binary)
            self.assertAlmostEqual(bounds[2][1] - bounds[2][0], 2.25, places=5)
            self.assertGreater(bounds[2][1] - bounds[2][0], 1.8)
            self.assertEqual(definitions[0]['footprint']['depth_cm'], 225)
            self.assertEqual(definitions[0]['walk_obstacle'], definitions[0]['footprint'])
            self.assertNotEqual(result, source)
            self.assertEqual(source.read_bytes(), previous)
            self.assertEqual(records[1], untouched)
            self.assertEqual(thumbnail.read_bytes(), (library / (record['thumbnail_asset_key'] + '.png')).read_bytes())
            with patch.object(MODULE, 'prepare_gltf_cached', side_effect=AssertionError('unchanged scale rebuilt')):
                MODULE.resize_selection(records, assets, definitions, configuration)
            builtin = root / 'internal/assets/builtin'
            builtin.mkdir(parents=True)
            shared_catalog = builtin / 'catalog.json'
            shared_catalog.write_text('[{"key":"existing-resource"}]\n')
            scene_path = root / 'internal/island/spatial-scene.json'
            scene_path.parent.mkdir(parents=True)
            scene_path.write_text('{"catalog":[]}\n')
            fragment = root / 'merge.json'
            MODULE.publish_selection(records[:1], assets, definitions, configuration, fragment)
            self.assertEqual(shared_catalog.read_text(), '[{"key":"existing-resource"}]\n')
            self.assertEqual(scene_path.read_text(), '{"catalog":[]}\n')
            result = json.loads(fragment.read_text())
            self.assertEqual(len(result['assets']), 2)
            self.assertEqual(len(result['definitions']), 1)
            self.assertTrue(source.exists())


class ProviderStaticCLITest(unittest.TestCase):
    """在临时库运行实际CLI，完整库失败不能被空发布范围掩盖。"""

    # 两个审核模型共享最小实际GLB，其中一个损坏用于分批恢复。
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ['scripts', 'internal/assets/builtin', 'source/previews']:
            (self.root/name).mkdir(parents=True)
        shutil.copy2(Path(__file__).with_name('import-provider-assets.py'), self.root/'scripts/import-provider-assets.py')
        self.write('internal/assets/builtin/catalog.json', [])
        self.write('internal/assets/provider-pack-manifest.json', {'snapshot_at': 'test', 'packs': [{'status': 'downloaded', 'provider': 'kenney', 'id': 'fixture', 'name': 'fixture', 'source_url': 'https://example.test', 'directory': 'source'}]})
        self.write('scripts/provider-static-policy.json', {'packs': {'kenney/fixture': {'include': ['good', 'bad'], 'exclude': {'wall': 'building-component'}}}})
        self.write('scripts/provider-release-selection.json', {'items': [], 'target_count': 0, 'csv_headers': {}, 'unselected_reason': 'library-only'})
        positions = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 1)
        doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(positions)}], 'bufferViews': [{'buffer': 0, 'byteLength': len(positions)}], 'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0}
        self.model = MODULE.glb_bytes(doc, positions)
        (self.root/'source/good.glb').write_bytes(self.model)
        (self.root/'source/bad.glb').write_bytes(b'invalid')
        (self.root/'source/wall.glb').write_bytes(b'excluded invalid model')
        for key in ['good', 'bad']:
            (self.root/f'source/previews/{key}.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')

    # 配置只写入临时仓库。
    def write(self, path, value):
        (self.root/path).write_text(json.dumps(value))

    # 子进程使用真实解析、缓存和清单写入，不模拟CLI返回码。
    def run_cli(self):
        result = subprocess.run([sys.executable, str(self.root/'scripts/import-provider-assets.py'), '--catalog-output', str(self.root/'publication.json')], cwd=self.root, capture_output=True, text=True, timeout=30)
        path = self.root/'internal/assets/provider-asset-manifest.json'
        self.assertTrue(path.exists(), result.stdout+result.stderr)
        report = json.loads(path.read_text())
        return result, report

    # 一个模型失败时保留另一个产物，修复源后可恢复，明确排除不算失败。
    def test_partial_failure_and_retry_have_real_exit_codes(self):
        result, report = self.run_cli()
        self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(report['counts'], {'failed': 1, 'prepared': 1, 'excluded': 1})
        good = next(item for item in report['items'] if item['model_id'] == 'good')
        library = self.root/'.local/3d-sources/provider-prepared/library'
        good_model = library/(good['model_asset_key']+'.glb')
        before = good_model.read_bytes()
        (self.root/'source/bad.glb').write_bytes(self.model)
        result, report = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(report['counts'], {'prepared': 2, 'excluded': 1})
        self.assertEqual(good_model.read_bytes(), before)
        self.assertEqual(len(report['definitions']), 2)


if __name__ == '__main__':
    unittest.main()
