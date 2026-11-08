"""用已接受的角色模型验证 GLB 换色后的实际序列化结果。"""

import importlib.util
import json
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).with_name('modular-character-dye-glb.py')
SPEC = importlib.util.spec_from_file_location('modular_character_dye_glb', MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ROOT = Path(__file__).resolve().parents[1]
MAGE_HAT = 'kaykit-adventurers-mage-head'
SHOES = 'shoes_outfit'
GLOVES = 'upper_hands001'


class ModularCharacterDyeGlbTest(unittest.TestCase):
    """检验三角形分配、原数据保留和同图集多部位换色。"""

    def setUp(self):
        """每个测试从同一正式模型创建独立实例。"""
        catalog = json.loads((ROOT / 'internal/character/character-catalog.json').read_text())
        mage = next(item for item in catalog['wearables'] if item['wearable_key'] == MAGE_HAT)
        self.source = (ROOT / 'internal/assets/builtin' / (mage['model_asset_key'] + '.glb')).read_bytes()
        self.glb = MODULE.Glb(self.source)

    def test_split_retains_geometry_and_original_material(self):
        """拆开部分面只改变目标索引，其余缓冲字节和资源引用原样保留。"""
        original = self.glb.surface(SHOES)
        selected = {0, 2, 4}
        material_name = 'test_dye_material'
        self.glb.add_dye(material_name, {(SHOES, 0): selected})
        output = MODULE.Glb(self.glb.to_bytes())

        self.assertEqual(output.primitive_count(SHOES), 2)
        fixed, dyed = [output.surface(SHOES, index) for index in range(2)]
        self.assertEqual(fixed.triangles, [face for index, face in enumerate(original.triangles) if index not in selected])
        self.assertEqual(dyed.triangles, [face for index, face in enumerate(original.triangles) if index in selected])
        self.assertEqual(fixed.image.tobytes(), original.image.tobytes())
        for surface in (fixed, dyed):
            self.assertEqual(surface.positions, original.positions)
            self.assertEqual(surface.uvs, original.uvs)
        red, green, blue = dyed.sample_triangle(0)
        self.assertEqual((red, green), (green, blue))
        original_glb = MODULE.Glb(self.source)
        for key in ('nodes', 'skins', 'scenes'):
            self.assertEqual(output.document[key], original_glb.document[key])
        self.assertEqual(output.document['materials'][:-1], original_glb.document['materials'])
        self.assertEqual(output.document['materials'][-1]['name'], material_name)
        mesh = next(node['mesh'] for node in original_glb.document['nodes'] if node['name'] == SHOES)
        index = original_glb.document['meshes'][mesh]['primitives'][0]['indices']
        accessor = original_glb.document['accessors'][index]
        view = original_glb.document['bufferViews'][accessor['bufferView']]
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        end = start + accessor['count'] * 2
        self.assertEqual(output.binary[:start], original_glb.binary[:start])
        self.assertEqual(output.binary[end:len(original_glb.binary)], original_glb.binary[end:])

    def test_shared_atlas_creates_distinct_materials_and_reuses_texture(self):
        """同一图集各槽能独立染色，相同锚点复用纹理字节。"""
        anchor = (104, 97, 157)
        initial_images = len(self.glb.document['images'])
        clone = MODULE.Glb(self.source)
        for glb in (self.glb, clone):
            glb.add_dye('test_dye_shoes', {(SHOES, 0): {0, 1, 2}}, anchor)
            glb.add_dye('test_dye_gloves', {(GLOVES, 0): {1, 2}}, anchor)
        self.assertEqual(self.glb.to_bytes(), clone.to_bytes())

        output = MODULE.Glb(self.glb.to_bytes())
        shoes_material, gloves_material = output.document['materials'][-2:]
        self.assertNotEqual(shoes_material['name'], gloves_material['name'])
        self.assertEqual(shoes_material['pbrMetallicRoughness'], gloves_material['pbrMetallicRoughness'])
        self.assertEqual(len(output.document['images']), initial_images + 1)

    def test_invalid_selection_leaves_glb_untouched(self):
        """错误的面编号在写入模型前拒绝。"""
        baseline = self.glb.to_bytes()
        with self.assertRaises(ValueError):
            self.glb.add_dye('test_dye_invalid', {(SHOES, 0): {100_000}})
        self.assertEqual(self.glb.to_bytes(), baseline)

    def test_full_primitive_keeps_existing_index_data(self):
        """整组换色直接使用原索引。"""
        original = self.glb.surface(SHOES)
        accessor_count = len(self.glb.document['accessors'])
        self.glb.add_dye('test_dye_shoes', {(SHOES, 0): set(range(len(original.triangles)))})
        output = MODULE.Glb(self.glb.to_bytes())
        self.assertEqual(output.primitive_count(SHOES), 1)
        self.assertEqual(output.surface(SHOES).triangles, original.triangles)
        self.assertEqual(len(output.document['accessors']), accessor_count)


if __name__ == '__main__':
    unittest.main()
