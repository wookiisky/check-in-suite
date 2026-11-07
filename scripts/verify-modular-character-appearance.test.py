"""逐件检查必须覆盖正式目录，并在部分失败后保留可核对的证据。"""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('modular_evidence', Path(__file__).with_name('verify-modular-character-appearance.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


# 候选与正式目录使用真实文件证明优先级和缺失引用，不依赖 Blender 假网格。
class ModularCandidateSourcesTest(unittest.TestCase):
    # 同 key 使用候选；复用正式动作必须声明精确哈希。
    def test_candidate_has_priority_and_requires_declared_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate, formal = [Path(temporary)/name for name in ['candidate', 'formal']]
            candidate.mkdir()
            formal.mkdir()
            (candidate/'shared.glb').write_bytes(b'candidate bytes')
            (formal/'shared.glb').write_bytes(b'formal bytes')
            (formal/'motion.glb').write_bytes(b'actual motion')
            self.assertEqual(MODULE.asset_path('shared', candidate, formal), candidate/'shared.glb')
            with self.assertRaisesRegex(FileNotFoundError, 'undeclared'):
                MODULE.asset_path('motion', candidate, formal)
            (candidate/'reused-assets.json').write_text(json.dumps({'motion.glb': hashlib.sha256(b'actual motion').hexdigest()}))
            self.assertEqual(MODULE.asset_path('motion', candidate, formal), formal/'motion.glb')
            (formal/'motion.glb').write_bytes(b'changed motion')
            with self.assertRaisesRegex(ValueError, 'reused asset checksum'):
                MODULE.asset_path('motion', candidate, formal)
            self.assertEqual(MODULE.asset_path('shared', None, formal), formal/'shared.glb')
            hashes, paths = {}, {}
            actual = MODULE.read_asset_source('shared', hashes, candidate, paths)
            self.assertEqual(actual, candidate/'shared.glb')
            self.assertEqual(hashes['shared'], hashlib.sha256(b'candidate bytes').hexdigest())
            self.assertEqual(paths['shared'], str(actual.resolve()))

    # 两处都没有的引用必须报出 key 和搜索路径，不能换成另一件素材。
    def test_unknown_asset_reference_fails_with_both_search_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate, formal = [Path(temporary)/name for name in ['candidate', 'formal']]
            with self.assertRaises(FileNotFoundError) as caught:
                MODULE.asset_path('unknown-reference', candidate, formal)
            for value in ['unknown-reference', str(candidate), str(formal)]:
                self.assertIn(value, str(caught.exception))

    # 可重复命令的两个输入参数必须传到执行边界，默认值仍是正式目录。
    def test_candidate_cli_paths_reach_verifier(self):
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            self.assertEqual(MODULE.main(['--catalog', '/tmp/review/catalog.json', '--asset-directory', '/tmp/review/builtin', '--render-only']), 0)
        options = verify.call_args.args[0]
        self.assertEqual(options.catalog, Path('/tmp/review/catalog.json'))
        self.assertEqual(options.asset_directory, Path('/tmp/review/builtin'))
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            self.assertEqual(MODULE.main(['--render-only']), 0)
        self.assertEqual(verify.call_args.args[0].catalog, MODULE.ROOT/'internal/character/character-catalog.json')
        self.assertIsNone(verify.call_args.args[0].asset_directory)


# 用不同默认项证明逐件检查按身体组装，而不是复用某一套默认衣服。
class ModularEvidenceScenariosTest(unittest.TestCase):
    # 每种基础身体都有自己的默认脸与衣服。
    def setUp(self):
        defaults = {'face': 'face-human', 'head': 'head-empty', 'upper': 'upper-default'}
        self.catalog = {
            'characters': [
                {'character_key': 'human', 'name': '人形', 'body_key': 'shared', 'rig_key': 'rig', 'defaults': defaults},
                {'character_key': 'skeleton', 'name': '骷髅', 'body_key': 'shared', 'rig_key': 'rig',
                 'defaults': {**defaults, 'face': 'face-skeleton', 'upper': 'upper-empty'}},
            ],
            'wearables': [
                {'wearable_key': key, 'name': key, 'slot': slot, 'body_key': 'shared', 'rig_key': 'rig', 'empty': empty}
                for key, slot, empty in [
                    ('face-human', 'face', False), ('face-skeleton', 'face', False),
                    ('head-empty', 'head', True), ('upper-empty', 'upper', True),
                    ('upper-default', 'upper', False), ('head-beard', 'head', False),
                ]
            ],
        }

    # 非空条目在每种兼容身体上均有一套四向检查，默认值不需要购买身份。
    def test_every_wearable_is_checked_on_each_body_without_replacing_other_slots(self):
        scenarios = MODULE.build_scenarios(self.catalog, [], all_wearables=True)
        self.assertEqual(len(scenarios), 8)
        self.assertEqual(len({item['key'] for item in scenarios}), 8)
        for body in self.catalog['characters']:
            actual = [item for item in scenarios if item['body'] == body['character_key']]
            self.assertEqual({item['wearable_key'] for item in actual},
                             {'face-human', 'face-skeleton', 'upper-default', 'head-beard'})
            beard = next(item for item in actual if item['wearable_key'] == 'head-beard')
            self.assertEqual(beard['selection'], {'head': 'head-beard'})
            face = next(item for item in actual if item['wearable_key'] == 'face-human')
            self.assertEqual(face['selection'], {'face': 'face-human', 'head': 'head-empty'})

    # 精确筛选两个名字相近的物件，拼写错误不能悄悄变成空的成功报告。
    def test_only_filters_exact_stable_keys_and_rejects_unknown_keys(self):
        scenarios = MODULE.build_scenarios(self.catalog, [], only=['head-beard'])
        self.assertEqual([item['wearable_key'] for item in scenarios], ['head-beard', 'head-beard'])
        with self.assertRaisesRegex(ValueError, 'head-bear'):
            MODULE.build_scenarios(self.catalog, [], only=['head-bear'])

    # 非兼容的骨架不混装，也不能因为空槽存在就为它生成检查。
    def test_incompatible_body_is_excluded(self):
        self.catalog['characters'][1]['rig_key'] = 'other-rig'
        scenarios = MODULE.build_scenarios(self.catalog, [], all_wearables=True)
        self.assertEqual({item['body'] for item in scenarios}, {'human'})

    # 同一问题头饰逐个配到指定脸型，避免默认脸正常却遗漏其他脸的遮挡。
    def test_headwear_can_be_checked_against_each_explicit_face(self):
        scenarios = MODULE.build_scenarios(self.catalog, [], only=['head-beard'],
                                           faces=['face-human', 'face-skeleton'])
        self.assertEqual(len(scenarios), 4)
        self.assertEqual(len({item['key'] for item in scenarios}), 4)
        for body in ['human', 'skeleton']:
            actual = [item for item in scenarios if item['body'] == body]
            self.assertEqual({item['selection']['face'] for item in actual}, {'face-human', 'face-skeleton'})
            self.assertTrue(all(item['selection']['head'] == 'head-beard' for item in actual))
        with self.assertRaisesRegex(ValueError, 'unknown-face'):
            MODULE.build_scenarios(self.catalog, [], only=['head-beard'], faces=['unknown-face'])
        with self.assertRaisesRegex(ValueError, 'head'):
            MODULE.build_scenarios(self.catalog, [], only=['upper-default'], faces=['face-human'])

    # 代表混穿仍保留原来的选择；追加动作不应取代静态对照。
    def test_representative_scenarios_and_requested_motion_keep_rest_comparison(self):
        representatives = [{'key': 'mixed', 'name': '混穿', 'body': 'human', 'selection': {'head': 'head-beard'}}]
        scenarios = MODULE.build_scenarios(self.catalog, representatives, motions=['walk'])
        self.assertEqual([item['key'] for item in scenarios], ['mixed', 'mixed--walk'])
        self.assertEqual([item['pose'] for item in scenarios], ['rest', 'walk'])
        self.assertEqual(scenarios[0]['selection'], representatives[0]['selection'])


# 共享采样计划决定实际执行的帧和四向，未实现的局部镜头不伪造通过。
class ModularSamplingPlanTest(unittest.TestCase):
    # 同一穿戴的精确帧与比例采样各有独立身份，不能都落到35%帧。
    def test_sampling_expands_exact_and_normalized_frames(self):
        scenario = {'key': 'human--coat', 'name': 'coat', 'body': 'human', 'wearable_key': 'coat', 'slot': 'upper', 'selection': {'upper': 'coat'}, 'pose': 'rest'}
        sampling = {'views': ['back', 'front'], 'poses': [{'motion': 'rest', 'frame': 0}, {'motion': 'read', 'frame': 48}], 'motions': ['walk'], 'motion_samples': [0, .7, 1]}
        actual = MODULE.sampling_scenarios([scenario], sampling)
        self.assertEqual(len(actual), 5)
        self.assertEqual(len({item['key'] for item in actual}), 5)
        self.assertEqual(actual[1]['frame'], 48)
        self.assertEqual(actual[1]['pose'], 'read')
        self.assertEqual(actual[3]['normalized_time'], .7)
        self.assertEqual(MODULE.sample_frame((10, 110), actual[3]), 80)
        self.assertEqual(MODULE.sample_frame((10, 110), actual[1]), 48)
        self.assertEqual(MODULE.scenario_coverage(actual[1], ['back', 'front']), ['human:upper:coat@back@read@frame:48', 'human:upper:coat@front@read@frame:48'])

    # CLI读取规则文件的sampling字段，错误视角或非法时间不能被忽略。
    def test_sampling_plan_rejects_invalid_time_and_views(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'rules.json'
            for sampling in [{'views': ['scalp'], 'poses': [{'motion': 'rest', 'frame': 0}]}, {'views': ['front'], 'poses': [{'motion': 'rest', 'frame': 0}], 'motion_samples': [float('nan')]}]:
                path.write_text(json.dumps({'sampling': sampling}))
                with self.assertRaises(ValueError):
                    MODULE.read_sampling_plan(path)


# 清单的成功状态来自每项实际执行结果，不能在最后无条件写 complete。
class ModularEvidenceReportTest(unittest.TestCase):
    # 中间失败保留其位置，后续项仍处理，已落盘项可供定位。
    def test_failure_is_recorded_without_skipping_later_scenarios(self):
        scenarios = [{'key': key, 'name': key, 'body': 'human', 'selection': {}, 'pose': 'rest'}
                     for key in ['first', 'broken', 'last']]
        visited = []

        # 假渲染器只用于证明调度失败恢复，不用它声称模型或像素正确。
        def render(scenario):
            visited.append(scenario['key'])
            if scenario['key'] == 'broken':
                raise ValueError('missing actual mesh')
            return {'status': 'rendered', 'source_sha256': {'model': scenario['key']}, 'files': []}

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            report = MODULE.run_scenarios(scenarios, output, render)
            saved = json.loads((output / 'evidence.json').read_text())
        self.assertEqual(visited, ['first', 'broken', 'last'])
        self.assertFalse(report['complete'])
        self.assertEqual(saved['summary'], {'rendered': 2, 'failed': 1})
        self.assertEqual([item['key'] for item in saved['items']], visited)
        self.assertEqual(saved['items'][1]['error'], 'missing actual mesh')
        self.assertEqual(saved['items'][2]['source_sha256'], {'model': 'last'})


if __name__ == '__main__':
    unittest.main()
