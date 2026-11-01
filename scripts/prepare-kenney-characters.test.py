"""验证Kenney试加工只写独立工作区，正式目录和审核状态保持原样。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('kenney_preparation', ROOT / 'scripts/prepare-kenney-characters.py')


# 工作区隔离是试加工允许未验收输入的前提。
class KenneyPreparationTest(unittest.TestCase):
    # 指定源可以试生成，但不能把正式配置的未验收状态改为已通过。
    def test_workspace_isolates_unverified_source_and_outputs(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        original = (ROOT / 'scripts/kenney-character-sources.json').read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'workspace'
            selected = module.prepare_workspace(ROOT, workspace, ['kenney-blocky-characters-a'])
            self.assertEqual(selected, ['kenney-blocky-characters-a'])
            staged = json.loads((workspace / 'scripts/kenney-character-sources.json').read_text())
            self.assertEqual(len(staged['sources']), 1)
            self.assertTrue(staged['sources'][0]['normalization']['head_envelope_verified'])
            self.assertTrue(staged['preparation_only'])
            self.assertFalse((workspace / 'internal/assets/builtin').is_symlink())
            self.assertTrue((workspace / 'internal/assets/builtin/character-medium-v1.glb').is_file())
            self.assertEqual((ROOT / 'scripts/kenney-character-sources.json').read_bytes(), original)

    # 拼错身份不能静默退化成全量加工。
    def test_unknown_source_does_not_create_workspace(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'workspace'
            with self.assertRaisesRegex(ValueError, 'unknown'):
                module.prepare_workspace(ROOT, workspace, ['not-a-reviewed-character'])
            self.assertFalse(workspace.exists())


if __name__ == '__main__':
    unittest.main()
