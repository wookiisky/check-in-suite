"""首批建筑整理不会恢复旧人物，并保持已发布资源不可覆写。"""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT/'scripts/prepare-3d-resources.py'


# 构造带真实外链字节的glTF容器，核对整理结果而非源代码字符串。
def source_model(with_image=True):
    document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 0}],
                'images': [{'uri': 'texture.png'}] if with_image else []}
    content = json.dumps(document).encode()
    content += b' ' * (-len(content) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(content))
            + struct.pack('<II', len(content), 0x4E4F534A) + content
            + struct.pack('<II', 0, 0x004E4942))


class LegacyResourcePreparationTest(unittest.TestCase):
    """对独立目录运行真实整理逻辑，覆盖职责退出和不可覆写。"""

    # 每个用例只操作临时源、目标与已存在的人物哨兵。
    def setUp(self):
        specification = importlib.util.spec_from_file_location('legacy_resources', MODULE)
        self.module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.module.P0 = self.directory/'p0'
        self.module.BUILTIN = self.directory/'builtin'
        for path in [self.module.P0/'character', self.module.P0/'animations',
                     self.module.P0/'kenney', self.module.BUILTIN]:
            path.mkdir(parents=True, exist_ok=True)
        (self.module.P0/'character/modular.glb').write_bytes(b'retired-character')
        (self.module.P0/'animations/exercise.glb').write_bytes(b'animation')
        (self.module.P0/'kenney/texture.png').write_bytes(b'embedded-image-bytes')
        for filename in self.module.BUILDING_FILES.values():
            (self.module.P0/'kenney'/filename).write_bytes(source_model())
        self.character = self.module.BUILTIN/'character-medium-v1.glb'
        self.character.write_bytes(b'current-character')

    # 整理建筑和动作后，旧人物复制路径不能改写当前角色。
    def test_preparation_only_writes_buildings_and_animation(self):
        self.module.prepare()
        self.assertEqual(self.character.read_bytes(), b'current-character')
        self.assertEqual((self.module.BUILTIN/'character-exercise-v1.glb').read_bytes(), b'animation')
        for key in self.module.BUILDING_FILES:
            data = (self.module.BUILTIN/(key+'.glb')).read_bytes()
            size = struct.unpack_from('<I', data, 12)[0]
            document = json.loads(data[20:20+size])
            self.assertNotIn('uri', document['images'][0])
            self.assertIn(b'embedded-image-bytes', data)
        self.module.prepare()

    # 同一真实整理接口允许镜像候选，不向现有正式身体或建筑写入。
    def test_explicit_candidate_root_has_mirrored_outputs(self):
        output = self.directory / 'candidate'
        before = {path.name: path.read_bytes() for path in self.module.BUILTIN.iterdir()}
        self.module.prepare(output)
        self.assertEqual({path.name: path.read_bytes() for path in self.module.BUILTIN.iterdir()}, before)
        self.assertTrue((output / 'internal/assets/builtin/camp-wall-v1.glb').exists())

    # CLI保留注册表的元数据，所有生成模型均能在候选注册表查到。
    def test_cli_preserves_registry_and_registers_each_generated_model(self):
        self.module.ROOT = self.directory
        animation = self.module.P0 / 'animations/exercise.glb'
        animation.write_bytes(source_model(with_image=False))
        keys = ['character-exercise-v1', *self.module.BUILDING_FILES]
        entries = [{'key': key, 'name': key, 'format': 'glb', 'kind': 'animation' if key == 'character-exercise-v1' else 'model', 'url': '/api/v1/assets/' + key, 'license': 'fixture-license', 'source_url': 'fixture:source'} for key in keys]
        official = self.directory / 'internal/assets/builtin/catalog.json'
        official.parent.mkdir(parents=True)
        original = json.dumps(entries, indent=2) + '\n'
        official.write_text(original)
        output = self.directory / '.local/candidate'
        self.module.main(['--output', str(output)])
        self.assertEqual(official.read_text(), original)
        candidate = output / 'internal/assets/builtin/catalog.json'
        self.assertEqual(candidate.read_text(), original)
        registered = {entry['key']: entry['format'] for entry in json.loads(candidate.read_text())}
        for model in candidate.parent.glob('*.glb'):
            self.assertEqual(registered[model.stem], 'glb')
        report = json.loads((output / 'candidate.json').read_text())
        self.assertEqual(report['pipeline'], 'resources')
        self.assertEqual(report['states']['checks'], 'not_run')
        specification = importlib.util.spec_from_file_location('pipeline_integrity', Path(__file__).with_name('asset-pipeline.py'))
        pipeline = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(pipeline)
        pipeline.check_integrity(self.directory, output, report)

    # 同一目标身份若已有不同字节，整理失败并保留原文件。
    def test_existing_building_identity_is_not_overwritten(self):
        target = self.module.BUILTIN/'camp-wall-v1.glb'
        target.write_bytes(b'published-building')
        with self.assertRaisesRegex(ValueError, 'immutable-resource-changed'):
            self.module.prepare()
        self.assertEqual(target.read_bytes(), b'published-building')


if __name__ == '__main__':
    unittest.main()
