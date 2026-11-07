"""用实际房型几何约束检查门洞、室内和扩建范围。"""

import importlib.util
from pathlib import Path
import unittest
import json
import sys
import tempfile
from unittest.mock import patch


# 普通 Python 只加载配置计算，不引入 Blender 运行依赖。
def load_preparation():
    path = Path(__file__).with_name('prepare-tiny-treats.py')
    spec = importlib.util.spec_from_file_location('tiny_treats_preparation', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TinyTreatsGeometryTests(unittest.TestCase):
    """两个房型均保留可达入口和完整室内地面。"""

    # 房型墙体不填平门洞，门内外通路覆盖人物半径。
    def test_door_opening_has_no_wall_and_room_has_floor(self):
        module = load_preparation()
        for variant in module.CONTENT['houses']:
            house = module.house_geometry(variant)
            door = house['door_center']
            for wall in house['walls']:
                self.assertFalse(wall['min_x_cm'] < door['x_cm'] < wall['max_x_cm']
                                 and wall['min_z_cm'] <= door['z_cm'] <= wall['max_z_cm'])
            self.assertLess(house['interior']['min_z_cm'], door['z_cm'])
            self.assertGreater(house['door_width_cm'], 80)
            self.assertGreaterEqual(house['door_height_cm'], 220)
            self.assertEqual(set(house['wall_nodes']), {'north', 'south', 'east', 'west'})

    # 扩建屋具有更大使用面积和独立身份，避免只更换名称。
    def test_extension_has_larger_room_and_distinct_model(self):
        module = load_preparation()
        cottage, courtyard = [module.house_geometry(item) for item in module.CONTENT['houses']]
        for axis in ('x', 'z'):
            self.assertGreater(courtyard['interior'][f'max_{axis}_cm'], cottage['interior'][f'max_{axis}_cm'])
        self.assertNotEqual(cottage['house_key'], courtyard['house_key'])
        self.assertNotEqual(cottage['model_url'], courtyard['model_url'])


class TinyTreatsCandidateTests(unittest.TestCase):
    """真实入口配合几何替身验证所有写入隔离，无需Blender或真实素材。"""

    # 模型和清单写候选镜像，正式源目录保持原字节。
    def test_main_writes_candidate_without_touching_source(self):
        module = load_preparation()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            output = Path(directory) / 'candidate'
            root.mkdir()
            builtin = root / 'internal/assets/builtin'
            builtin.mkdir(parents=True)
            retained = {'key': 'retained', 'name': '既有素材', 'kind': 'model', 'format': 'glb', 'url': '/api/v1/assets/retained', 'license': 'fixture-license'}
            (builtin/'catalog.json').write_text(json.dumps([retained]))
            (builtin/'retained.glb').write_bytes(b'retained')
            source = root / 'fixture.gltf'
            source.write_text('{}')
            pack_manifest = (root / module.CONTENT['source_root']).parent / 'pack-manifest.json'
            pack_manifest.parent.mkdir(parents=True)
            pack_manifest.write_text('{"packs":[]}')
            def make_house(variant, destination):
                model = destination / (variant['house_key'] + '.glb')
                model.write_bytes(b'fixture-glb')
                return model, module.house_geometry(variant)
            with patch.object(module, 'ROOT', root), patch.object(module, 'source_model', return_value=source), patch.object(module, 'prepare_house', side_effect=make_house), patch.object(sys, 'argv', ['prepare', '--only', 'cottage', '--output', str(output)]):
                module.main()
            self.assertTrue((output / 'candidate.json').exists())
            self.assertTrue((output / 'internal/assets/tiny-treats-manifest.json').exists())
            self.assertEqual(json.loads((builtin/'catalog.json').read_text()), [retained])
            catalog = json.loads((output/'internal/assets/builtin/catalog.json').read_text())
            self.assertEqual(catalog[0], retained)
            registered = {entry['key']: entry for entry in catalog}
            for model in (output/'internal/assets/builtin').glob('*.glb'):
                self.assertEqual(registered[model.stem]['format'], 'glb')
                self.assertTrue(registered[model.stem]['source_url'])
                self.assertTrue(registered[model.stem]['license'])
            self.assertEqual(source.read_text(), '{}')
            report = json.loads((output / 'candidate.json').read_text())
            self.assertEqual(report['states']['checks'], 'not_run')
            specification = importlib.util.spec_from_file_location('pipeline_integrity', Path(__file__).with_name('asset-pipeline.py'))
            pipeline = importlib.util.module_from_spec(specification)
            specification.loader.exec_module(pipeline)
            pipeline.check_integrity(root, output, report)
            self.assertTrue(any(item['path'].endswith('.glb') for item in report['generated']))


if __name__ == '__main__':
    unittest.main()
