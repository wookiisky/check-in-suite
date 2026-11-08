"""流程测试只使用临时小文件，不读取或处理项目素材。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location('pipeline', Path(__file__).with_name('asset-pipeline.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PipelineContractTest(unittest.TestCase):
    # 商品类别不决定制作能力，必须显式声明加工类型。
    def test_explicit_type_required(self):
        with self.assertRaisesRegex(ValueError, 'processing_type'):
            MODULE.classify({'category': 'building'})
        self.assertEqual('static', MODULE.classify({'processing_type': 'static', 'category': 'building'}))

    # 缺失检查不能靠一份complete标志变成可应用状态。
    def test_missing_required_check_blocks(self):
        results = MODULE.summarize_checks(['source-components', 'visual'], {'visual': {'status': 'passed'}})
        self.assertEqual('not_run', results['source-components']['status'])
        self.assertFalse(MODULE.checks_passed(results))

    # 证据需要同时匹配候选与规则版本。
    def test_stale_evidence_rejected(self):
        with self.assertRaisesRegex(ValueError, 'stale'):
            MODULE.validate_evidence({'candidate_sha256': 'old', 'rules_sha256': 'rule'}, 'new', 'rule')

    # 中断恢复只能恢复本次写入，不能覆盖之后出现的新修改。
    def test_recovery_refuses_unrelated_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root/'internal/catalog.json'
            path.parent.mkdir()
            path.write_bytes(b'other edit')
            journal = {'state': 'applying', 'files': [{'path': 'internal/catalog.json', 'before': 'b2xk', 'after_sha256': MODULE.digest(b'new')}]}
            journal_path = root/'journal.json'
            journal_path.write_text(json.dumps(journal))
            with self.assertRaisesRegex(ValueError, 'changed'):
                MODULE.recover(root, journal_path)
            self.assertEqual(b'other edit', path.read_bytes())

    # 真正写入后恢复精确旧字节；新增产物删除，无关文件保留。
    def test_recovery_restores_previous_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'internal').mkdir()
            (root/'internal/catalog.json').write_bytes(b'new')
            (root/'internal/keep').write_bytes(b'keep')
            journal_path = root/'journal.json'
            journal_path.write_text(json.dumps({'state': 'applying', 'files': [{'path': 'internal/catalog.json', 'before': 'b2xk', 'after_sha256': MODULE.digest(b'new') }]}))
            MODULE.recover(root, journal_path)
            self.assertEqual(b'old', (root/'internal/catalog.json').read_bytes())
            self.assertEqual(b'keep', (root/'internal/keep').read_bytes())

    # 尚未写入的新目录无需创建，恢复可跳过仍不存在的新文件。
    def test_recovery_skips_uncreated_generated_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            journal = root/'journal.json'
            journal.write_text(json.dumps({'state': 'applying', 'files': [
                {'path': 'internal/new-directory/new.glb', 'before': None, 'after_sha256': MODULE.digest(b'new')}]}))
            self.assertEqual('recovered', MODULE.recover(root, journal)['state'])
            self.assertFalse((root/'internal').exists())


class ClassificationCoverageTest(unittest.TestCase):
    # 混合管线只把适用规则交给对应资产，动画使用片段采样。
    def test_mixed_resource_rules_follow_each_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root/'.local/candidate'
            builtin = output/'internal/assets/builtin'
            builtin.mkdir(parents=True)
            (builtin/'catalog.json').write_text(json.dumps([
                {'key': 'wall', 'format': 'glb', 'kind': 'model'},
                {'key': 'exercise', 'format': 'glb', 'kind': 'animation'}]))
            manifest = {'pipeline': 'resources', 'generated': [{'path': 'internal/assets/builtin/'+key+'.glb'} for key in ['wall','exercise']]}
            plan = MODULE.coverage_plan(root, output, manifest, json.loads(MODULE.RULES.read_text()))
            self.assertEqual(['internal/assets/builtin/wall.glb'], plan['placement'])
            self.assertEqual(['internal/assets/builtin/exercise.glb'], plan['motion'])
            self.assertTrue(any('@clip@time:' in case for case in plan['visual'] if 'exercise' in case))
            self.assertFalse(any('@clip@' in case for case in plan['visual'] if 'wall' in case))

    # 场景定义变更须检查地形与通路，不能仅作为普通JSON免去专项。
    def test_environment_definitions_have_navigation_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            output=root/'.local/candidate'
            path=output/'internal/island/spatial-scenes.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps([{'scene_key':'garden','scene':{'regions':[]}}]))
            plan=MODULE.coverage_plan(root,output,{'pipeline':'tiny-treats','generated':[{'path':'internal/island/spatial-scenes.json'}]},json.loads(MODULE.RULES.read_text()))
            self.assertEqual(['scene:garden'],plan['walk-surfaces'])
            self.assertNotIn('cutaway',plan)

    # 不适配任何身体的非空穿戴不能从检查计划中静默消失。
    def test_orphan_wearable_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root/'.local/candidate'
            path = output/'internal/character/character-catalog.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'characters': [{'character_key': 'body', 'body_key':'one', 'rig_key':'rig'}], 'wearables':[{'wearable_key':'orphan','body_key':'other','rig_key':'rig','slot':'upper'}]}))
            with self.assertRaisesRegex(ValueError, 'compatible body'):
                MODULE.coverage_plan(root, output, {'pipeline':'characters','generated':[]}, json.loads(MODULE.RULES.read_text()))


class LocalHairstyleCoverageTest(unittest.TestCase):
    # 两个身体共用同一绑定姿势，候选按兼容脸型检查头皮。
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root/'.local/candidate'
        self.catalog_path = Path('internal/character/character-catalog.json')
        standard = {'body_key': 'shared', 'rig_key': 'rig'}
        self.original = {
            'characters': [{'character_key': key, **standard} for key in ['human', 'skeleton']],
            'wearables': [
                {'wearable_key': 'smile', 'slot': 'face', **standard},
                {'wearable_key': 'skull', 'slot': 'face', **standard},
                {'wearable_key': 'other-shape', 'slot': 'face', 'body_key': 'other', 'rig_key': 'rig'},
                {'wearable_key': 'existing-upper', 'slot': 'upper', **standard},
            ],
            'animation_sets': {'rig': {}},
        }
        self.hair = {'wearable_key': 'sample-hair', 'slot': 'head', **standard,
                     'provider': 'local', 'pack_key': 'local-hairstyles',
                     'model_asset_key': 'sample-hair-model', 'dye_material': 'hair-dye',
                     'thumbnail_asset_key': 'sample-hair-thumb', 'default_color_key': 'brown'}
        self.model_path = 'internal/assets/builtin/sample-hair-model.glb'
        self.thumb_path = 'internal/assets/builtin/sample-hair-thumb.png'
        self.paths = [self.catalog_path.as_posix(), self.model_path, self.thumb_path]
        self.write_catalog(self.root, self.original)

    # 测试覆盖计划只需要候选和正式目录，二进制检查由流程测试负责。
    def write_catalog(self, root, catalog):
        path = root/self.catalog_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(catalog))

    # 使用指定的生成文件计算实际验收案例。
    def plan(self, paths, catalog=None):
        if catalog is None:
            catalog = {**self.original, 'wearables': [*self.original['wearables'], self.hair]}
        self.write_catalog(self.output, catalog)
        manifest = {'pipeline': 'local-hairstyles', 'generated': [{'path': path} for path in paths]}
        return MODULE.coverage_plan(self.root, self.output, manifest, json.loads(MODULE.RULES.read_text()))

    # 仅新增发型参与脸型组合，动作与静态视角的覆盖分别明确。
    def test_review_compatible_faces_only(self):
        plan = self.plan(self.paths)
        cases = ['skull:head:sample-hair', 'smile:head:sample-hair']
        for rule in ['source-components', 'rig', 'coverage', 'gltf']:
            self.assertEqual(cases, plan[rule])
        self.assertEqual(19, len(plan['visual']))
        self.assertIn('smile:head:sample-hair@scalp@rest@frame:0', plan['visual'])
        self.assertIn('skull:head:sample-hair@right@read@frame:48', plan['visual'])
        self.assertIn('skull:head:sample-hair@front@walk@time:0.35', plan['visual'])
        self.assertIn(self.thumb_path+'@image@rest@frame:0', plan['visual'])

    # 重新制作同一发型的模型也需要覆盖验收，即使正式目录的引用没有改变。
    def test_rebuilt_unchanged_hairstyle_requires_review(self):
        self.original['wearables'].append(self.hair)
        self.write_catalog(self.root, self.original)
        plan = self.plan(self.paths, self.original)
        self.assertEqual(['skull:head:sample-hair', 'smile:head:sample-hair'], plan['coverage'])

    # 模型必须来自本次候选，额外模型不能跳过人物专项验证。
    def test_missing_and_unassigned_models_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'hairstyle model'):
            self.plan([self.catalog_path.as_posix(), self.thumb_path])
        with self.assertRaisesRegex(ValueError, 'hairstyle model'):
            self.plan([*self.paths, 'internal/assets/builtin/other.glb'])

    # 发型入口不能借机发布其他槽位或修改正式脸型。
    def test_non_hairstyle_changes_are_rejected(self):
        self.hair['slot'] = 'upper'
        with self.assertRaisesRegex(ValueError, 'local hairstyle'):
            self.plan(self.paths)
        self.hair['slot'] = 'head'
        changed_face = {**self.original['wearables'][0], 'covers': ['scalp']}
        catalog = {**self.original, 'wearables': [changed_face, *self.original['wearables'][1:], self.hair]}
        with self.assertRaisesRegex(ValueError, 'local hairstyle'):
            self.plan(self.paths, catalog)

    # 正式穿戴的稳定身份不得被发型替代，候选内也不能重复使用一个身份。
    def test_existing_identity_and_duplicate_are_rejected(self):
        unrelated = self.original['wearables'][-1]
        replacement = {**self.hair, 'wearable_key': unrelated['wearable_key']}
        catalog = {**self.original, 'wearables': [*self.original['wearables'][:-1], replacement]}
        with self.assertRaisesRegex(ValueError, 'local hairstyle'):
            self.plan(self.paths, catalog)
        catalog['wearables'] = [*self.original['wearables'], self.hair, self.hair]
        with self.assertRaisesRegex(ValueError, 'duplicate wearable'):
            self.plan(self.paths, catalog)


class CandidateLifecycleTest(unittest.TestCase):
    # 每个测试使用独立仓库和JSON夹具，永远不访问项目GLB。
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)/'repo'
        self.output = self.root/'.local/candidate'
        (self.root/'internal/island').mkdir(parents=True)
        self.target = self.root/'internal/island/spatial-scene.json'
        self.target.write_text('{"catalog": []}')
        helper = MODULE.candidate_tools()
        baseline = helper.capture_baseline(self.root)
        candidate = self.output/'internal/island/spatial-scene.json'
        candidate.parent.mkdir(parents=True)
        candidate.write_text('{"catalog": [], "revision": 2}')
        builtin = self.output/'internal/assets/builtin'
        builtin.mkdir(parents=True)
        (builtin/'fixture.glb').write_bytes(b'fixture GLB checked by a test double')
        (builtin/'catalog.json').write_text(json.dumps([{'key':'fixture','format':'glb','kind':'model','url':'/api/v1/assets/fixture'}]))
        helper.finalize_candidate(self.root, self.output, 'provider', baseline=baseline)

    # 验收通过的夹具同时声明每个必需案例和证据文件。
    def approve(self):
        manifest = MODULE.verify_candidate(self.root, self.output)
        rules = json.loads(MODULE.RULES.read_text())
        plan = MODULE.coverage_plan(self.root, self.output, manifest, rules)
        proof = self.output/'fixture-proof.json'
        proof.write_text('{"reviewed": true}')
        records = [{'rule': key, 'status': 'passed', 'coverage': cases,
                    'evidence': [{'path': proof.name, 'sha256': MODULE.digest(proof.read_bytes())}]} for key, cases in plan.items() if key not in ['integrity', 'gltf']]
        evidence = self.output/'review.json'
        evidence.write_text(json.dumps({'candidate_sha256': MODULE.digest((self.output/'candidate.json').read_bytes()),
                                      'rules_sha256': MODULE.digest(MODULE.RULES.read_bytes()), 'results': records}))
        with mock.patch.object(MODULE, 'check_gltf', return_value={'status': 'passed'}):
            report = MODULE.check(self.root, self.output, evidence)
        self.assertEqual('passed', report['status'])

    # 退役夹具同时保留持久历史和未注册源码，用于验证移出的严格边界。
    def prepare_retirement(self):
        builtin = self.root/'internal/assets/builtin'
        builtin.mkdir(parents=True, exist_ok=True)
        self.retired = [builtin/'retired-a.glb', builtin/'retired-b.png']
        for path in self.retired:
            path.write_bytes(b'old source '+path.name.encode())
        self.unrelated = builtin/'unregistered.svg'
        self.unrelated.write_bytes(b'keep unrelated source')
        self.persistent = self.root/'.local/assets/retired-a.glb'
        self.persistent.parent.mkdir(parents=True)
        self.persistent.write_bytes(b'persistent installed history')
        catalog = builtin/'catalog.json'
        current = json.loads((self.output/'internal/assets/builtin/catalog.json').read_text())
        catalog.write_text(json.dumps(current+[{'key': 'retired-a', 'format': 'glb'}, {'key': 'retired-b', 'format': 'png'}]))
        self.original_catalog = catalog.read_bytes()
        helper = MODULE.candidate_tools()
        return helper.finalize_candidate(self.root, self.output, 'provider', baseline=helper.capture_baseline(self.root))

    # 只归档并移出已退役源码，持久历史和无关源码字节保持不变。
    def test_apply_archives_only_declared_retired_sources(self):
        manifest = self.prepare_retirement()
        before = {path: path.read_bytes() for path in self.retired}
        self.assertEqual(2, len(manifest['retired_source_files']))
        self.approve()
        MODULE.apply(self.root, self.output)
        journal = json.loads((self.root/'.local/asset-pipeline/application.json').read_text())
        removals = [entry for entry in journal['files'] if entry['after_sha256'] is None]
        self.assertEqual(2, len(removals))
        for entry in removals:
            source = self.root/entry['path']
            self.assertFalse(source.exists())
            self.assertEqual(before[source], (self.root/entry['archive']).read_bytes())
        self.assertEqual(b'keep unrelated source', self.unrelated.read_bytes())
        self.assertEqual(b'persistent installed history', self.persistent.read_bytes())

    # 退役源码基线漂移时，正式目录和其他文件尚未写入。
    def test_retirement_baseline_drift_blocks_before_writes(self):
        self.prepare_retirement()
        self.approve()
        self.retired[0].write_bytes(b'other edit')
        with self.assertRaisesRegex(ValueError, '(retirement|baseline).*changed'):
            MODULE.apply(self.root, self.output)
        self.assertEqual(self.original_catalog, (self.root/'internal/assets/builtin/catalog.json').read_bytes())
        self.assertEqual('{"catalog": []}', self.target.read_text())
        self.assertEqual(b'other edit', self.retired[0].read_bytes())

    # 验收后换成同字节软链也须拒绝，避免解析旧路径后移出仍注册的目标。
    def test_retirement_rejects_same_byte_symlink_before_apply(self):
        self.prepare_retirement()
        current = self.root/'internal/assets/builtin/fixture.glb'
        content = (self.output/'internal/assets/builtin/fixture.glb').read_bytes()
        current.write_bytes(content)
        self.retired[0].write_bytes(content)
        helper = MODULE.candidate_tools()
        helper.finalize_candidate(self.root, self.output, 'provider', baseline=helper.capture_baseline(self.root))
        self.approve()
        self.retired[0].unlink()
        self.retired[0].symlink_to(current.name)
        with self.assertRaisesRegex(ValueError, 'retirement.*symlink'):
            MODULE.apply(self.root, self.output)
        self.assertEqual(content, current.read_bytes())
        self.assertEqual(self.original_catalog, (self.root/'internal/assets/builtin/catalog.json').read_bytes())
        self.assertTrue(self.retired[0].is_symlink())

    # 声明不能将当前生成文件、目录或未注册文件作为可随意删除的路径。
    def test_retirement_rejects_paths_outside_catalog_difference(self):
        for name in ['internal/island/spatial-scene.json', 'internal/assets/builtin/catalog.json',
                     'internal/assets/builtin/reused-assets.json', 'internal/assets/builtin/unregistered.svg']:
            with self.subTest(path=name):
                manifest = self.prepare_retirement() if not hasattr(self, 'retired') else json.loads((self.output/'candidate.json').read_text())
                manifest['retired_source_files'] = [entry for entry in manifest.get('retired_source_files', []) if entry['path'] in [str(path.relative_to(self.root)) for path in self.retired]]
                manifest['retired_source_files'].append({'path': name, 'sha256': 'not a retirement'})
                (self.output/'candidate.json').write_text(json.dumps(manifest))
                self.approve()
                with self.assertRaisesRegex(ValueError, 'retirement declaration'):
                    MODULE.apply(self.root, self.output)
                self.assertEqual(self.original_catalog, (self.root/'internal/assets/builtin/catalog.json').read_bytes())

    # 未声明退役的历史候选继续沿用旧行为，不能推断并删除旧文件。
    def test_legacy_candidate_without_retirements_keeps_sources(self):
        manifest = self.prepare_retirement()
        manifest.pop('retired_source_files', None)
        (self.output/'candidate.json').write_text(json.dumps(manifest))
        self.approve()
        MODULE.apply(self.root, self.output)
        self.assertTrue(all(path.is_file() for path in self.retired))
        self.assertFalse((self.root/'.local/asset-pipeline/retired').exists())

    # 归档已有不同字节时拒绝覆盖，且尚未移出源码。
    def test_retirement_rejects_conflicting_archive(self):
        self.prepare_retirement()
        self.approve()
        batch = MODULE.digest((self.output/'candidate.json').read_bytes())
        archive = self.root/'.local/asset-pipeline/retired'/batch/self.retired[0].relative_to(self.root)
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b'different archived bytes')
        with self.assertRaisesRegex(ValueError, 'retired archive changed'):
            MODULE.apply(self.root, self.output)
        self.assertTrue(all(path.is_file() for path in self.retired))
        self.assertEqual(b'different archived bytes', archive.read_bytes())

    # 移出首个源码后发生异常，现有恢复流程还原目录及全部精确旧字节。
    def test_retirement_exception_restores_sources_and_catalog(self):
        self.prepare_retirement()
        self.approve()
        before = {path: path.read_bytes() for path in self.retired}
        original = MODULE.remove_file
        interrupted = False
        def interrupt(path):
            nonlocal interrupted
            original(path)
            if path.resolve() == self.retired[0].resolve() and not interrupted:
                interrupted = True
                raise OSError('interrupted after source removal')
        with mock.patch.object(MODULE, 'remove_file', side_effect=interrupt):
            with self.assertRaisesRegex(OSError, 'after source removal'):
                MODULE.apply(self.root, self.output)
        self.assertEqual(self.original_catalog, (self.root/'internal/assets/builtin/catalog.json').read_bytes())
        for path, data in before.items():
            self.assertEqual(data, path.read_bytes())
        self.assertEqual('recovered', json.loads((self.root/'.local/asset-pipeline/application.json').read_text())['state'])
        self.assertEqual(2, len(list((self.root/'.local/asset-pipeline/retired').rglob('retired-*.*'))))

    # 真正强制退出后，先拒绝覆盖外部修改，再恢复本批所有旧源码。
    def test_retirement_process_exit_recovers_without_overwriting_edits(self):
        self.prepare_retirement()
        self.approve()
        before = {path: path.read_bytes() for path in self.retired}
        program = """
import importlib.util, os, sys
from pathlib import Path
s=importlib.util.spec_from_file_location('pipeline',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(sys.argv[2]);output=Path(sys.argv[3]);original=m.remove_file
def terminate(path):
    original(path)
    if path.name=='retired-a.glb':os._exit(73)
m.remove_file=terminate
m.apply(root,output)
"""
        process = subprocess.run([sys.executable, '-c', program, str(Path(MODULE.__file__)), str(self.root), str(self.output)])
        self.assertEqual(73, process.returncode)
        self.assertFalse(self.retired[0].exists())
        self.retired[1].write_bytes(b'other edit after interruption')
        with self.assertRaisesRegex(ValueError, 'recovery target changed'):
            MODULE.apply(self.root, None, recovery=True)
        self.assertEqual(b'other edit after interruption', self.retired[1].read_bytes())
        self.assertFalse(self.retired[0].exists())
        self.retired[1].write_bytes(before[self.retired[1]])
        result = MODULE.apply(self.root, None, recovery=True)
        self.assertEqual('recovered', result['state'])
        self.assertEqual(self.original_catalog, (self.root/'internal/assets/builtin/catalog.json').read_bytes())
        for path, data in before.items():
            self.assertEqual(data, path.read_bytes())
        self.assertEqual(b'persistent installed history', self.persistent.read_bytes())

    # 缺失专项和画面结论时，自动检查通过也不能应用。
    def test_incomplete_check_blocks_apply(self):
        with mock.patch.object(MODULE, 'check_gltf', return_value={'status': 'passed'}):
            report = MODULE.check(self.root, self.output)
        self.assertEqual('incomplete', report['status'])
        with self.assertRaisesRegex(ValueError, 'required checks'):
            MODULE.apply(self.root, self.output)
        self.assertEqual('{"catalog": []}', self.target.read_text())

    # 正式目录变化后拒绝应用，并保留新修改。
    def test_apply_rechecks_baseline(self):
        self.approve()
        self.target.write_text('other edit')
        with self.assertRaisesRegex(ValueError, 'baseline changed'):
            MODULE.apply(self.root, self.output)
        self.assertEqual('other edit', self.target.read_text())

    # 应用使用已验收的精确字节，应用回归仍未执行。
    def test_apply_exact_candidate(self):
        self.approve()
        result = MODULE.apply(self.root, self.output)
        self.assertEqual('applied', result['state'])
        self.assertEqual('not_run', result['application_checks'])
        self.assertEqual((self.output/'internal/island/spatial-scene.json').read_bytes(), self.target.read_bytes())

    # 审查附件改变，已有通过记录失效。
    def test_changed_review_attachment_blocks_apply(self):
        self.approve()
        (self.output/'fixture-proof.json').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'evidence file changed'):
            MODULE.apply(self.root, self.output)

    # 普通url引用也必须存在于显式资源闭包中。
    def test_plain_url_missing_dependency_is_rejected(self):
        manifest = MODULE.verify_candidate(self.root, self.output)
        (self.output/'internal/island/spatial-scene.json').write_text('{"url": "/api/v1/assets/missing"}')
        with self.assertRaisesRegex(ValueError, '(undeclared|unregistered) asset'):
            MODULE.check_integrity(self.root, self.output, manifest)

    # 本地完整库清单不等于运行目录，未精选资源不要求进入发行集合。
    def test_library_manifest_is_not_runtime_catalog(self):
        manifest = MODULE.verify_candidate(self.root, self.output)
        report = self.output/'internal/assets/provider-asset-manifest.json'
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text('{"assets": [{"url": "/api/v1/assets/library-only"}]}')
        manifest['generated'].append({'path': 'internal/assets/provider-asset-manifest.json'})
        MODULE.check_integrity(self.root, self.output, manifest)

    # 日志写入后候选发生变化，也只能写入已固定的验收字节。
    def test_candidate_change_after_journal_keeps_verified_bytes(self):
        self.approve()
        expected = (self.output/'internal/island/spatial-scene.json').read_bytes()
        original = MODULE.write_json
        def mutate_after_journal(path, value):
            original(path, value)
            if value.get('state') == 'applying':
                (self.output/'internal/island/spatial-scene.json').write_text('changed after verification')
        with mock.patch.object(MODULE, 'write_json', side_effect=mutate_after_journal):
            MODULE.apply(self.root, self.output)
        self.assertEqual(expected, self.target.read_bytes())

    # 编排层补充公共依赖时必须保留类别入口登记的源模型。
    def test_build_retains_adapter_dependencies(self):
        helper = MODULE.candidate_tools()
        output = self.root/'.local/new-candidate'
        (self.root/'scripts').mkdir()
        (self.root/'scripts/import-provider-assets.py').write_text('# fixture adapter')
        source = self.root/'source.glb'
        source.write_bytes(b'fixture source')
        def adapter(command, **kwargs):
            baseline = helper.capture_baseline(self.root)
            path = output/'internal/island/spatial-scene.json'
            path.parent.mkdir(parents=True)
            path.write_text('{}')
            helper.finalize_candidate(self.root, output, 'provider', baseline=baseline,
                                      dependencies=helper.capture_dependencies(self.root, [source]))
        with mock.patch.object(MODULE, 'ROOT', self.root), mock.patch.object(MODULE.subprocess, 'run', side_effect=adapter), mock.patch.object(sys, 'argv', ['pipeline', 'build', '--pipeline', 'provider', '--output', str(output)]):
            MODULE.main()
        record = json.loads((output/'candidate.json').read_text())
        self.assertIn(str(source.resolve()), [entry['path'] for entry in record['dependencies']])
        source.write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError, 'dependency changed'):
            MODULE.verify_candidate(self.root, output)

    # 非build未知参数必须在动作调用前拒绝。
    def test_unknown_argument_does_not_apply(self):
        with mock.patch.object(sys, 'argv', ['pipeline', 'apply', '--output', str(self.output), '--typo']), mock.patch.object(MODULE, 'apply') as operation:
            with self.assertRaises(SystemExit):
                MODULE.main()
            operation.assert_not_called()

    # 分批复核只增加实际已审案例，重跑自动检查不丢失前批结论。
    def test_partial_reviews_accumulate_without_false_pass(self):
        manifest = MODULE.verify_candidate(self.root, self.output)
        plan = MODULE.coverage_plan(self.root, self.output, manifest, json.loads(MODULE.RULES.read_text()))
        proof = self.output/'proof.json'
        proof.write_text('{}')
        visual = plan['visual']
        base = {'candidate_sha256': MODULE.digest((self.output/'candidate.json').read_bytes()), 'rules_sha256': MODULE.digest(MODULE.RULES.read_bytes())}
        def import_batch(cases):
            path = self.output/'batch.json'
            path.write_text(json.dumps({**base, 'results':[{'rule':'visual','status':'passed','coverage':cases,'evidence':[{'path':'proof.json','sha256':MODULE.digest(proof.read_bytes())}]}]}))
            with mock.patch.object(MODULE,'check_gltf',return_value={'status':'passed'}):
                return MODULE.check(self.root,self.output,path)
        first = import_batch(visual[:1])
        self.assertEqual('needs_review',first['results']['visual']['status'])
        second = import_batch(visual[1:])
        self.assertEqual('passed',second['results']['visual']['status'])
        self.assertEqual(visual,second['results']['visual']['coverage'])
        self.assertEqual('not_run',second['results']['placement']['status'])
        with mock.patch.object(MODULE,'check_gltf',return_value={'status':'passed'}):
            repeated=MODULE.check(self.root,self.output)
        self.assertEqual('passed',repeated['results']['visual']['status'])

    # 接受警告不能丢失自动报告的哈希，报告改变后应用必须拒绝。
    def test_warning_acceptance_keeps_automatic_report(self):
        self.approve()
        evidence = json.loads((self.output/'review.json').read_text())
        plan = json.loads((self.output/'checks.json').read_text())['plan']
        evidence['results'].append({'rule':'gltf','status':'passed','coverage':plan['gltf'],
            'evidence':[{'path':'fixture-proof.json','sha256':MODULE.digest((self.output/'fixture-proof.json').read_bytes())}]})
        review=self.output/'warning-review.json'
        review.write_text(json.dumps(evidence))
        report_path=self.output/'gltf-check.json'
        report_path.write_text('{"warnings":1}')
        automatic={'status':'needs_review','report':report_path.name,'sha256':MODULE.digest(report_path.read_bytes())}
        evidence['results'][-1]['automatic_sha256']=automatic['sha256']
        review.write_text(json.dumps(evidence))
        with mock.patch.object(MODULE,'check_gltf',return_value=automatic):
            report=MODULE.check(self.root,self.output,review)
        self.assertEqual('passed',report['results']['gltf']['status'])
        self.assertEqual(automatic['sha256'],report['results']['gltf']['sha256'])
        report_path.write_text('changed')
        with self.assertRaisesRegex(ValueError,'automatic report changed'):
            MODULE.apply(self.root,self.output)

    # 已被新复核完全覆盖的旧附件不再参与当前验收。
    def test_revised_review_replaces_old_attachment(self):
        plan={'visual':['one']}
        proof=self.output/'revised.json'
        proof.write_text('old review')
        old={'rule':'visual','status':'failed','coverage':['one'],'evidence':[{'path':proof.name,'sha256':MODULE.digest(proof.read_bytes())}]}
        proof.write_text('revised review')
        new={**old,'status':'passed','evidence':[{'path':proof.name,'sha256':MODULE.digest(proof.read_bytes())}]}
        result=MODULE.merge_evidence(self.output,plan,{},[old,new])
        self.assertEqual('passed',result['visual']['status'])

    # 新的自动警告报告不能沿用旧报告的人工接受结论。
    def test_warning_review_is_bound_to_automatic_report(self):
        proof=self.output/'proof.json'
        proof.write_text('{}')
        record={'rule':'gltf','status':'passed','coverage':['model'],'automatic_sha256':'old-report',
            'evidence':[{'path':proof.name,'sha256':MODULE.digest(proof.read_bytes())}]}
        with self.assertRaisesRegex(ValueError,'stale automatic'):
            MODULE.merge_evidence(self.output,{'gltf':['model']},{'gltf':{'status':'needs_review','sha256':'new-report'}},[record])

    # 校验时间不改变格式结论，连续检查仍可导入并保留同一警告复核。
    def test_validation_timestamp_preserves_warning_review(self):
        reports = [self.gltf_process(time) for time in ['first', 'second', 'third']]
        with mock.patch.object(MODULE.subprocess, 'run', side_effect=reports):
            initial = MODULE.check(self.root, self.output)
            proof = self.output/'warning-proof.json'
            proof.write_text('{"reviewed": true}')
            review = self.output/'warning-review.json'
            review.write_text(json.dumps({
                'candidate_sha256': initial['candidate_sha256'], 'rules_sha256': initial['rules_sha256'],
                'results': [{'rule': 'gltf', 'status': 'passed', 'coverage': initial['plan']['gltf'],
                             'automatic_sha256': initial['automatic']['gltf']['sha256'],
                             'evidence': [{'path': proof.name, 'sha256': MODULE.digest(proof.read_bytes())}]}]}))
            imported = MODULE.check(self.root, self.output, review)
            repeated = MODULE.check(self.root, self.output)
        self.assertEqual('passed', imported['results']['gltf']['status'])
        self.assertEqual('passed', repeated['results']['gltf']['status'])
        self.assertEqual(initial['automatic']['gltf']['sha256'], repeated['automatic']['gltf']['sha256'])
        saved = json.loads((self.output/'gltf-check.json').read_text())
        expected = json.loads(reports[-1].stdout)
        del expected['files'][0]['validation']['validatedAt']
        self.assertEqual(expected, saved)

    # 真正警告内容变化仍会撤销此前的接受记录。
    def test_changed_validation_issue_invalidates_warning_review(self):
        with mock.patch.object(MODULE.subprocess, 'run', return_value=self.gltf_process('first')):
            initial = MODULE.check(self.root, self.output)
        proof = self.output/'warning-proof.json'
        proof.write_text('{}')
        review = self.output/'warning-review.json'
        review.write_text(json.dumps({
            'candidate_sha256': initial['candidate_sha256'], 'rules_sha256': initial['rules_sha256'],
            'results': [{'rule': 'gltf', 'status': 'passed', 'coverage': initial['plan']['gltf'],
                         'automatic_sha256': initial['automatic']['gltf']['sha256'],
                         'evidence': [{'path': proof.name, 'sha256': MODULE.digest(proof.read_bytes())}]}]}))
        with mock.patch.object(MODULE.subprocess, 'run', return_value=self.gltf_process('first')):
            accepted = MODULE.check(self.root, self.output, review)
        self.assertEqual('passed', accepted['results']['gltf']['status'])
        with mock.patch.object(MODULE.subprocess, 'run', return_value=self.gltf_process('second', 'DIFFERENT_WARNING')):
            changed = MODULE.check(self.root, self.output)
        self.assertNotEqual(initial['automatic']['gltf']['sha256'], changed['automatic']['gltf']['sha256'])
        self.assertEqual('needs_review', changed['results']['gltf']['status'])
        self.assertFalse(any(record['rule'] == 'gltf' for record in changed['review_records']))

    # 子进程夹具保留真实报告结构，仅控制时间与实际问题内容。
    def gltf_process(self, timestamp, warning='NODE_SKINNED_MESH_NON_ROOT'):
        report = {'validator': 'fixture-validator', 'summary': {'files': 1, 'errors': 0, 'warnings': 1},
                  'files': [{'file': 'fixture.glb', 'bytes': 42, 'validation': {
                      'validatorVersion': 'fixture-validator', 'validatedAt': timestamp,
                      'issues': {'numErrors': 0, 'numWarnings': 1,
                                 'messages': [{'code': warning, 'severity': 1, 'pointer': '/nodes/1'}]}}}]}
        return subprocess.CompletedProcess(['validator'], 0, stdout=json.dumps(report), stderr='')

    # 检查器依赖改变后重跑check必须停止继承旧专项结论。
    def test_changed_checker_dependencies_invalidate_saved_reviews(self):
        self.approve()
        with mock.patch.object(MODULE,'check_gltf',return_value={'status':'passed'}), mock.patch.object(MODULE,'check_dependencies',return_value=[{'path':'changed-checker','sha256':'v2'}]):
            result=MODULE.check(self.root,self.output)
        self.assertEqual('not_run',result['results']['visual']['status'])
        self.assertEqual('incomplete',result['status'])

    # 检查读取的正式注册表变化后，不能继续使用旧的通过结论。
    def test_changed_fallback_registry_blocks_application(self):
        candidate_catalog=self.output/'internal/assets/builtin/catalog.json'
        root_catalog=self.root/'internal/assets/builtin/catalog.json'
        root_catalog.parent.mkdir(parents=True)
        root_catalog.write_bytes(candidate_catalog.read_bytes())
        candidate_catalog.unlink()
        helper=MODULE.candidate_tools()
        helper.finalize_candidate(self.root,self.output,'provider',baseline=helper.capture_baseline(self.root))
        self.approve()
        root_catalog.write_text('[]')
        with self.assertRaisesRegex(ValueError,'(dependency changed|unregistered)'):
            MODULE.apply(self.root,self.output)

    # 注册为GLB的资源不能借同名PNG文件通过引用检查。
    def test_reference_requires_registered_extension(self):
        manifest=MODULE.verify_candidate(self.root,self.output)
        manifest['generated']=[entry for entry in manifest['generated'] if not entry['path'].endswith('fixture.glb')]
        manifest['reused'].append({'path':'internal/assets/builtin/fixture.png'})
        with self.assertRaisesRegex(ValueError,'undeclared asset'):
            MODULE.check_integrity(self.root,self.output,manifest)

    # --resume通过主入口转给动作处理器，不误覆盖完成候选。
    def test_build_resume_is_forwarded_to_animation_adapter(self):
        helper=MODULE.candidate_tools()
        output=self.root/'.local/resume-candidate'
        output.mkdir(parents=True)
        (output/'interrupted.log').write_text('partial')
        (self.root/'scripts').mkdir()
        (self.root/'scripts/import-provider-animations.py').write_text('# fixture adapter')
        def adapter(command, **kwargs):
            self.assertIn('--resume',command)
            path=output/'internal/assets/provider-animation-manifest.json'
            path.parent.mkdir(parents=True)
            path.write_text('{}')
            helper.finalize_candidate(self.root,output,'animations',baseline=helper.capture_baseline(self.root))
        with mock.patch.object(MODULE,'ROOT',self.root), mock.patch.object(MODULE.subprocess,'run',side_effect=adapter), mock.patch.object(sys,'argv',['pipeline','build','--pipeline','animations','--output',str(output),'--resume']):
            self.assertEqual(0,MODULE.main())
        with mock.patch.object(MODULE,'ROOT',self.root), mock.patch.object(sys,'argv',['pipeline','build','--pipeline','animations','--output',str(output),'--resume']):
            with self.assertRaisesRegex(ValueError,'completed'):
                MODULE.main()

    # 派生阶段消费既有候选，并保留几何制作依赖和正式基线。
    def test_preview_stage_preserves_prior_candidate_dependencies(self):
        helper=MODULE.candidate_tools()
        source=self.root/'geometry-source.glb'
        source.write_bytes(b'original geometry input')
        helper.finalize_candidate(self.root,self.output,'tiny-treats',baseline=helper.capture_baseline(self.root),dependencies=helper.capture_dependencies(self.root,[source]))
        (self.root/'scripts').mkdir()
        (self.root/'scripts/render-tiny-treats-previews.py').write_text('# fixture preview stage')
        def stage(command, **kwargs):
            self.assertIn('render-tiny-treats-previews.py',' '.join(command))
            target=self.output/'internal/assets/tiny-treats-manifest.json'
            target.write_text('{"houses":[]}')
            helper.finalize_candidate(self.root,self.output,'tiny-treats',baseline=helper.capture_baseline(self.root))
        for flag in ['--directory', '--dir']:
            with mock.patch.object(MODULE,'ROOT',self.root), mock.patch.object(sys,'argv',['pipeline','build','--pipeline','tiny-treats','--stage','previews','--output',str(self.output),'--',flag,str(self.root/'.local/other')]), mock.patch.object(MODULE.subprocess,'run') as operation:
                with self.assertRaisesRegex(ValueError,'override output'):
                    MODULE.main()
                operation.assert_not_called()
        with mock.patch.object(MODULE,'ROOT',self.root), mock.patch.object(MODULE.subprocess,'run',side_effect=stage), mock.patch.object(sys,'argv',['pipeline','build','--pipeline','tiny-treats','--stage','previews','--output',str(self.output)]):
            self.assertEqual(0,MODULE.main())
        manifest=json.loads((self.output/'candidate.json').read_text())
        self.assertIn(str(source.resolve()),[entry['path'] for entry in manifest['dependencies']])
        source.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'dependency changed'):
            MODULE.verify_candidate(self.root,self.output)

    # 缩略图是实际图片，不能仅凭文件名或非空字节通过。
    def test_corrupt_thumbnail_fails_integrity(self):
        manifest=MODULE.verify_candidate(self.root,self.output)
        thumbnail=self.output/'internal/assets/builtin/broken.png'
        thumbnail.write_bytes(b'not an image')
        catalog=self.output/'internal/assets/builtin/catalog.json'
        entries=json.loads(catalog.read_text())
        entries.append({'key':'broken','format':'png','kind':'island','url':'/api/v1/assets/broken'})
        catalog.write_text(json.dumps(entries))
        manifest['generated'].append({'path':'internal/assets/builtin/broken.png'})
        with self.assertRaisesRegex(ValueError,'invalid candidate image'):
            MODULE.check_integrity(self.root,self.output,manifest)

    # 真实子进程在一次正式写入后强制退出，下一次恢复仍能拿到旧字节。
    def test_process_termination_recovery(self):
        self.approve()
        program = """
import importlib.util, os, sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('pipeline',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]).resolve();output=Path(sys.argv[3]).resolve();original=m.atomic_write

def terminate(path,data):
    original(path,data)
    if path.is_relative_to(root/'internal'):
        os._exit(73)
m.atomic_write=terminate
m.apply(root,output)
"""
        process = subprocess.run([sys.executable, '-c', program, str(Path(MODULE.__file__)), str(self.root), str(self.output)])
        self.assertEqual(73, process.returncode)
        self.assertEqual('applying', json.loads((self.root/'.local/asset-pipeline/application.json').read_text())['state'])
        result = MODULE.apply(self.root, None, recovery=True)
        self.assertEqual('recovered', result['state'])
        self.assertEqual('{"catalog": []}', self.target.read_text())


if __name__ == '__main__':
    unittest.main()
