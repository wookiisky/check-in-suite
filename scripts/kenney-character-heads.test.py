"""验证外化头发标注只选连通发型，不改变脸部身份。"""
import importlib.util
from pathlib import Path
import unittest

from PIL import Image

SPEC = importlib.util.spec_from_file_location('heads', Path(__file__).with_name('kenney-character-heads.py'))


class PaintedHairTest(unittest.TestCase):
    # 同色眼睛与头发之间有皮肤隔开，只抽取显式种子连通的头发。
    def test_connected_hair_preserves_face_and_eyes(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        image = Image.new('RGBA', (8, 8), (220, 170, 130, 255))
        for x in range(8):
            for y in range(2):
                image.putpixel((x, y), (30, 20, 10, 255))
        image.putpixel((3, 4), (30, 20, 10, 255))
        mask = module.connected_hair_mask(image, [0, 0, 8, 8], [[0, 0]], 0)
        hair, face = module.split_head_texture(image, mask, [220, 170, 130])
        self.assertEqual(mask.getpixel((3, 4)), 0)
        self.assertEqual(hair.getpixel((3, 4))[3], 0)
        self.assertEqual(face.getpixel((3, 4)), image.getpixel((3, 4)))
        self.assertEqual(hair.getpixel((1, 1)), image.getpixel((1, 1)))
        self.assertEqual(face.getpixel((1, 1)), (220, 170, 130, 255))

    # 外化的头部atlas之外，即使颜色相同也不能被选为头发。
    def test_atlas_bounds_and_invalid_seed(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        image = Image.new('RGBA', (8, 8), (30, 20, 10, 255))
        mask = module.connected_hair_mask(image, [0, 0, 4, 4], [[0, 0]], 0)
        self.assertEqual(mask.getpixel((7, 7)), 0)
        with self.assertRaises(ValueError):
            module.connected_hair_mask(image, [0, 0, 4, 4], [[5, 5]], 0)


if __name__ == '__main__':
    unittest.main()
