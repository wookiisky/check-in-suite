"""用真实 Blender 进程验证多视角预览及失败后的批处理恢复。"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BLENDER = Path(os.environ.get('BLENDER_PATH', '/Applications/Blender.app/Contents/MacOS/Blender'))


# 实际 GLB 盒体具有不同轴长，能证明世界边界被正确映射回 glTF 坐标。
def box_glb(external=False):
    vertices = [(x, y, z) for x in (-1, 1) for y in (0, 2) for z in (-.5, .5)]
    binary = b''.join(struct.pack('<3f', *point) for point in vertices)
    indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1,
               2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]
    binary += struct.pack('<36H', *indices)
    document = {
        'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'name': 'Box', 'mesh': 0}], 'buffers': [{'byteLength': len(binary)}],
        'bufferViews': [{'buffer': 0, 'byteLength': 96}, {'buffer': 0, 'byteOffset': 96, 'byteLength': 72}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 8, 'type': 'VEC3', 'min': [-1, 0, -.5], 'max': [1, 2, .5]},
                      {'bufferView': 1, 'componentType': 5123, 'count': 36, 'type': 'SCALAR'}],
        'materials': [{'doubleSided': True, 'pbrMetallicRoughness': {'baseColorFactor': [.25, .6, .3, 1], 'metallicFactor': 0}}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1, 'material': 0}]}],
    }
    if external:
        document['buffers'][0]['uri'] = 'mesh.bin'
    encoded = json.dumps(document).encode()
    encoded += b' ' * (-len(encoded) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(binary))
            + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


@unittest.skipUnless(BLENDER.is_file(), '需要本机 Blender 执行真实渲染')
class GltfPreviewBlenderTest(unittest.TestCase):
    """测试读取序列化 GLB 的真实渲染与逐项恢复行为。"""

    # 非自包含模型及缺失文件失败后，后续有效模型仍输出四张实际 PNG，源数据不变。
    def test_batch_failure_continues_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.glb'
            source.write_bytes(box_glb())
            external = root / 'external.glb'
            external.write_bytes(box_glb(external=True))
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            result = root / 'results.json'
            jobs = root / 'jobs.json'
            jobs.write_text(json.dumps({'settings': {'size': 64}, 'result_path': str(result), 'jobs': [
                {'key': 'missing', 'model': str(root / 'missing.glb'), 'output_directory': str(root / 'missing')},
                {'key': 'external', 'model': str(external), 'output_directory': str(root / 'external')},
                {'key': 'missing-node', 'model': str(source), 'output_directory': str(root / 'missing-node'), 'visible_nodes': ['Absent']},
                {'key': 'box', 'model': str(source), 'output_directory': str(root / 'box'), 'visible_nodes': ['Box'], 'scale': .5},
            ]}))
            completed = subprocess.run([str(BLENDER), '--background', '--factory-startup', '--python-exit-code', '1',
                                        '--python', str(ROOT / 'scripts/render-gltf-previews.py'), '--', '--jobs', str(jobs)],
                                       capture_output=True, text=True, timeout=180)
            self.assertNotEqual(completed.returncode, 0)
            self.assertTrue(result.is_file(), completed.stdout[-3000:] + completed.stderr[-3000:])
            report = json.loads(result.read_text())
            self.assertEqual([item['status'] for item in report['items']], ['failed', 'failed', 'failed', 'rendered'])
            rendered = report['items'][3]
            for actual, expected in zip(rendered['bounds_m'], [[-.5, .5], [0, 1], [-.25, .25]]):
                for value, target in zip(actual, expected):
                    self.assertAlmostEqual(value, target, places=5)
            self.assertEqual([Path(path).name for path in rendered['files']], ['front.png', 'right.png', 'back.png', 'left.png'])
            for path in rendered['files']:
                data = Path(path).read_bytes()
                self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(struct.unpack('>II', data[16:24]), (64, 64))
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            self.assertEqual(report['settings']['views'], ['front', 'right', 'back', 'left'])


if __name__ == '__main__':
    unittest.main()
