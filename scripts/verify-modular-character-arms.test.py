"""手臂检查必须使用准确动作帧、局部取景，并区分身体显隐诊断。"""
import importlib.util
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('arm_review', Path(__file__).with_name('verify-modular-character-arms.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


# 使用非正式名字测试通用目录枚举，不绑定某一轮商品文案。
class ArmReviewTest(unittest.TestCase):
    # 两个兼容身体和一个不兼容身体证明筛选来自契约。
    def setUp(self):
        self.catalog = {'characters': [dict(character_key=key, name=key, rig_key=rig, body_key='body')
                                       for key, rig in [('human', 'rig'), ('skeleton', 'rig'), ('other', 'other')]],
                        'wearables': [dict(wearable_key=key, name=key, slot=slot, rig_key='rig', body_key='body', empty=empty)
                                      for key, slot, empty in [('coat', 'upper', False), ('none', 'upper', True), ('shoe', 'shoes', False)]]}

    # 逐件只改上装，八个样本保留原始帧，不使用比例时间代替。
    def test_exact_frames_on_every_compatible_body(self):
        cases = MODULE.build_cases(self.catalog)
        self.assertEqual(len(cases), 2)
        self.assertEqual({case['body'] for case in cases}, {'human', 'skeleton'})
        self.assertTrue(all(case['selection'] == {'upper': 'coat'} for case in cases))
        self.assertEqual(MODULE.POSES, [('rest', 0), ('idle', 13), ('cheer', 11), ('cheer', 21),
                                      ('cheer', 31), ('read', 24), ('read', 48), ('read', 72)])

    # 错误 key 和非上装筛选不能产生空的成功报告。
    def test_exact_filter_rejects_unknown_or_other_slot(self):
        self.assertEqual(len(MODULE.build_cases(self.catalog, ['coat'])), 2)
        for key in ['missing', 'shoe', 'none']:
            with self.assertRaises(ValueError):
                MODULE.build_cases(self.catalog, [key])

    # 手臂与全身检查必须读同一候选，不因独立入口而悄悄退回正式目录。
    def test_candidate_cli_paths_reach_arm_verifier(self):
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            self.assertEqual(MODULE.main(['--catalog', '/tmp/arms/catalog.json', '--asset-directory', '/tmp/arms/builtin', '--render-only']), 0)
        options = verify.call_args.args[0]
        self.assertEqual(options.catalog, Path('/tmp/arms/catalog.json'))
        self.assertEqual(options.asset_directory, Path('/tmp/arms/builtin'))
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            self.assertEqual(MODULE.main(['--render-only']), 0)
        self.assertEqual(verify.call_args.args[0].catalog, MODULE.ROOT/'internal/character/character-catalog.json')
        self.assertIsNone(verify.call_args.args[0].asset_directory)

    # 外置计划覆盖硬编码姿势，过滤值必须来自本次计划。
    def test_sampling_plan_drives_pose_choices(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'sampling.json'
            path.write_text(json.dumps({'sampling': {'views': ['front'], 'poses': [{'motion': 'walk', 'frame': 17}]}}))
            with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
                MODULE.main(['--sampling-plan', str(path), '--pose', 'walk:17', '--render-only'])
            self.assertEqual(verify.call_args.args[0].sampling_poses, [('walk', 17)])
            with self.assertRaises(SystemExit), patch('sys.stderr'):
                MODULE.main(['--sampling-plan', str(path), '--pose', 'read:48', '--render-only'])

    # 隐藏身体的诊断图不能当作正式局部覆盖，未实现视角也不冒充完成。
    def test_coverage_excludes_diagnostic_and_maps_only_supported_views(self):
        case = {'body': 'human', 'wearable_key': 'coat'}
        frame = {'view': 'hand-end', 'angle': 'hand-end', 'pose': 'read', 'frame': 48, 'body_visible': True}
        self.assertEqual(MODULE.frame_coverage(case, frame), 'human:upper:coat@hand-end@read@frame:48')
        self.assertIsNone(MODULE.frame_coverage(case, {**frame, 'body_visible': False}))
        self.assertIsNone(MODULE.frame_coverage(case, {**frame, 'view': 'arm'}))
        self.assertEqual(MODULE.frame_coverage(case, {**frame, 'view': 'torso', 'angle': 'back'}), 'human:upper:coat@torso-back@read@frame:48')

    # 默认只在静态姿势生成显隐对照；主图始终存在。
    def test_diagnostic_is_rest_only_unless_explicitly_requested(self):
        self.assertEqual(MODULE.visibility_modes('rest', False), [True, False])
        self.assertEqual(MODULE.visibility_modes('read', False), [True])
        self.assertEqual(MODULE.visibility_modes('read', True), [True, False])

    # 手套由明确 key 选择；可选视角不能改变身体或穿戴枚举。
    def test_hand_end_view_requires_explicit_selection_and_keeps_default(self):
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            MODULE.main(['--view', 'hand-end', '--only', 'coat', '--pose', 'read:48', '--render-only'])
            options = verify.call_args.args[0]
            self.assertEqual(options.view, 'hand-end')
            self.assertEqual(options.only, ['coat'])
            self.assertEqual(options.pose, ['read:48'])
            self.assertEqual(len(MODULE.build_cases(self.catalog, options.only)), 2)
            MODULE.main(['--render-only'])
            self.assertEqual(verify.call_args.args[0].view, 'arm')
        with self.assertRaises(SystemExit), patch('sys.stderr'):
            MODULE.main(['--view', 'hand-end', '--render-only'])

    # 完整衣身检查必须明确选衣物，且每套只渲染一对胸背视角。
    def test_torso_view_requires_explicit_key_and_keeps_both_bodies(self):
        with patch.object(MODULE.importlib.util, 'find_spec', return_value=object()), patch.object(MODULE, 'verify', return_value=0) as verify:
            MODULE.main(['--view', 'torso', '--only', 'coat', '--pose', 'read:48', '--render-only'])
            options = verify.call_args.args[0]
            self.assertEqual(options.view, 'torso')
            self.assertEqual(len(MODULE.build_cases(self.catalog, options.only)), 2)
        with self.assertRaises(SystemExit), patch('sys.stderr'):
            MODULE.main(['--view', 'torso', '--render-only'])

    # 衣身点集包含腰部与中背；相机必须以整段衣身居中，不能沿用肩臂中心。
    def test_torso_camera_contains_abdomen_waist_and_middle_back(self):
        points = [(-.374631, -.371423, .719999), (.374622, .363779, 1.418710)]
        # 真实 RedMage REST 中背及 Read48 侧背穿出点，原 arm 图未覆盖完整衣身。
        regression_points = [(.1920235157, .2369704247, .7509154081),
                             (.3465008736, -.0303268433, .7925798893),
                             (.3481645584, .4001197815, .8683211207)]
        cameras = MODULE.torso_frames(points)
        self.assertEqual([name for name, _ in cameras], ['front', 'back'])
        for _, camera in cameras:
            self.assertAlmostEqual(camera['target'][0], 0, places=4)
            self.assertGreater(camera['target'][2], .9)
            self.assertLess(camera['target'][2], 1.1)
            for point in [*points,*regression_points]:
                relative = [a-b for a,b in zip(point,camera['target'])]
                for axis in ['right','up']:
                    self.assertLessEqual(abs(sum(a*b for a,b in zip(relative,camera[axis]))),camera['ortho_scale']/2/1.12)

    # torso诊断只按基础身体对象身份隐藏，不能误藏同一GLB里的真实衣物。
    def test_torso_diagnostic_hides_all_base_regions_but_preserves_clothing(self):
        body = {'fixed_nodes':['hands'],'body_regions':{'torso':['chest'],'arms':['arms'],'legs':['legs']}}
        base = {key:object() for key in ['hands','chest','arms','legs','coat']}
        selected = list(base.values())
        torso = MODULE.diagnostic_objects(body,base,selected,'torso')
        self.assertEqual(set(torso),{base[key] for key in ['hands','chest','arms','legs']})
        self.assertNotIn(base['coat'],torso)
        # 原有手臂诊断只隐藏arms及固定节点body_hands。
        self.assertEqual(MODULE.diagnostic_objects(body,base,selected,'arm'),[base['arms']])

    # 相机沿真实 hand head→tail 指向指端；左右轴互反，平移不能改变方向。
    def test_hand_axis_uses_world_transform_for_both_sides(self):
        matrix = [[0, -2, 0, 4], [3, 0, 0, -5], [0, 0, .5, 6], [0, 0, 0, 1]]
        for sign in [1, -1]:
            axis = MODULE.hand_axis_world((sign*.8, 0, 1), (sign*.9, 0, 1), matrix)
            for actual, expected in zip(axis['head'], [4, -5+sign*2.4, 6.5]):
                self.assertAlmostEqual(actual, expected)
            self.assertAlmostEqual(axis['direction'][0], 0)
            self.assertAlmostEqual(axis['direction'][1], sign*.3)
            self.assertAlmostEqual(axis['direction'][2], 0)

    # 手臂抬起后骨轴可能接近竖直，此时取景仍有两个有效投影轴。
    def test_vertical_hand_axis_has_finite_local_camera(self):
        for direction in [(0, 0, 1), (.00001, 0, 1)]:
            framing = MODULE.camera_frame([(-.07, -.08, 1), (.07, .08, 1.2)], direction, minimum_span=.12)
            self.assertLess(framing['ortho_scale'], .25)
            self.assertAlmostEqual(sum(value*value for value in framing['right']), 1)
            self.assertAlmostEqual(sum(value*value for value in framing['up']), 1)
            self.assertAlmostEqual(sum(a*b for a,b in zip(framing['right'],framing['direction'])), 0)
            self.assertGreater(framing['location'][2], framing['target'][2])

    # 同场景加载多个 GLB 时，数字后缀不能导致动作丢失或匹配到其他动作。
    def test_imported_action_numeric_suffix_preserves_clip_identity(self):
        for name in ['Read', 'Read.001', 'Rig|Read.002']:
            self.assertTrue(MODULE.imported_action_matches(name, 'Read'))
        for name in ['Reading', 'Read.Other', 'ReadLater.001']:
            self.assertFalse(MODULE.imported_action_matches(name, 'Read'))

    # 同一局部点集的镜头只由手臂决定，不能纳入整个人物包围盒。
    def test_camera_fits_local_arm_with_padding_for_every_view(self):
        points = [(.25, -.12, 1.08), (.92, .12, 1.3), (.7, 0, .95)]
        for direction in [(0.3, -1, .35), (.3, 1, .35)]:
            camera = MODULE.camera_frame(points, direction)
            self.assertLess(camera['ortho_scale'], 1.1)
            self.assertGreater(camera['ortho_scale'], .6)
            for point in points:
                relative = [a-b for a, b in zip(point, camera['target'])]
                for axis in ['right', 'up']:
                    projected = sum(a*b for a, b in zip(relative, camera[axis]))
                    self.assertLessEqual(abs(projected), camera['ortho_scale']/2/1.12)


if __name__ == '__main__':
    unittest.main()
