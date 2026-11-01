"""人物检查器在真实容器边界报告骨架、部件与损坏文件。"""
import importlib.util
import json
from pathlib import Path
import struct
import unittest

SPEC = importlib.util.spec_from_file_location('kenney_inspection', Path(__file__).with_name('inspect-kenney-characters.py'))


class ContainerInspectionTest(unittest.TestCase):
    # 合法GLB的元数据保持源身份，不猜测蒙皮。
    def test_actual_json_chunk(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        payload = json.dumps({'asset': {'version': '2.0'}, 'nodes': [{'name': 'head', 'mesh': 0}], 'meshes': [{'primitives': []}]}).encode()
        payload += b' ' * ((-len(payload)) % 4)
        document = module.glb_document(struct.pack('<III', 0x46546c67, 2, 20 + len(payload)) + struct.pack('<I4s', len(payload), b'JSON') + payload)
        self.assertEqual(document['nodes'][0]['name'], 'head')
        self.assertNotIn('skins', document)

    # 截断与错误版本不能产生看似成功的检查结果。
    def test_rejects_invalid_container(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        for data in [b'', b'not a glb', struct.pack('<III', 0x46546c67, 1, 12)]:
            with self.assertRaises(ValueError):
                module.glb_document(data)


if __name__ == '__main__':
    unittest.main()
