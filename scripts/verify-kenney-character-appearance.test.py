"""验证无蒙皮动作预览保留实际采样值及按骨名映射后的目标。"""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('kenney_appearance', ROOT / 'scripts/verify-kenney-character-appearance.py')


# 实际序列化后的动作必须仍指向正确骨名并保留输入输出数据。
class AnimationPreviewTest(unittest.TestCase):
    # Read动作没有skin，合到标准人物后才能在Blender中采样真实骨骼姿势。
    def test_read_animation_maps_nodes_and_preserves_sampler_bytes(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'read.glb'
            module.compose_animation_model(ROOT / 'internal/assets/builtin/character-medium-v1.glb', ROOT / 'internal/assets/builtin/character-living-v1.glb', 'Read', output)
            document, blob = module.read_glb(output)
            source, source_blob = module.read_glb(ROOT / 'internal/assets/builtin/character-living-v1.glb')
            self.assertTrue(document['skins'])
            self.assertEqual(len(document['animations']), 1)
            clip = next(clip for clip in source['animations'] if clip['name'] == 'Read')
            actual = document['animations'][0]
            self.assertEqual(actual['name'], 'Read')
            self.assertEqual([document['nodes'][channel['target']['node']]['name'] for channel in actual['channels']], [source['nodes'][channel['target']['node']]['name'] for channel in clip['channels']])
            for generated, original in zip(actual['samplers'], clip['samplers']):
                for field in ['input', 'output']:
                    accessor = document['accessors'][generated[field]]
                    view = document['bufferViews'][accessor['bufferView']]
                    source_accessor = source['accessors'][original[field]]
                    source_view = source['bufferViews'][source_accessor['bufferView']]
                    self.assertEqual(blob[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']], source_blob[source_view.get('byteOffset', 0):source_view.get('byteOffset', 0) + source_view['byteLength']])


if __name__ == '__main__':
    unittest.main()
