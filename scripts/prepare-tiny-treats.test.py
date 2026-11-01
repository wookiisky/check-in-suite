"""用实际房型几何约束检查门洞、室内和扩建范围。"""

import importlib.util
from pathlib import Path
import unittest


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


if __name__ == '__main__':
    unittest.main()
