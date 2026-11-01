"""以正式交付的 GLB 验证原始人物动作，而不是只核对旁边的清单。"""

import importlib.util
import json
import math
import hashlib
import tempfile
import subprocess
import sys
from unittest.mock import patch
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("provider_animations", ROOT / "scripts/import-provider-animations.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderAnimationDeliveryTest(unittest.TestCase):
    """动画文件只交付标准骨架与有效轨道，来源保持逐片段追踪。"""

    # 每个已登记片段必须存在，实际时间和目标骨骼必须可读取。
    def test_delivered_clips_target_canonical_skeleton(self):
        manifest = json.loads((ROOT / "internal/assets/provider-animation-manifest.json").read_text())
        self.assertGreaterEqual(len(manifest["animations"]), 15)
        canonical, _ = MODULE.read_document(ROOT / "internal/assets/builtin/character-medium-v1.glb")
        canonical_nodes = {node.get("name"): node for node in canonical["nodes"]}
        assets = {item["key"]: item for item in manifest["assets"]}
        for entry in manifest["animations"]:
            path = ROOT / "internal/assets/builtin" / (entry["asset_key"] + ".glb")
            doc, blob = MODULE.read_document(path)
            self.assertFalse(doc.get("meshes"), path)
            self.assertFalse(doc.get("images"), path)
            self.assertNotIn("uri", doc["buffers"][0])
            clip = next(item for item in doc["animations"] if item["name"] == entry["clip"])
            self.assertGreater(len(clip["channels"]), 0)
            for node in doc["nodes"]:
                original = canonical_nodes[node["name"]]
                for key in ["translation", "rotation", "scale", "matrix"]:
                    self.assertEqual(node.get(key), original.get(key), (path, node["name"], key))
            for channel in clip["channels"]:
                name = doc["nodes"][channel["target"]["node"]]["name"]
                self.assertIn(name, MODULE.CANONICAL_BONES)
                sampler = clip["samplers"][channel["sampler"]]
                times = MODULE.read_accessor(doc, blob, sampler["input"])
                self.assertGreater(times[-1][0], times[0][0], path)
                self.assertTrue(all(a[0] < b[0] for a, b in zip(times, times[1:])))
                values = MODULE.read_accessor(doc, blob, sampler["output"])
                self.assertEqual(len(times), len(values))
                self.assertTrue(all(math.isfinite(value) for row in values for value in row), path)
            self.assertEqual(assets[entry["asset_key"]]["kind"], "animation")

    # 场景负责水平导航，离线动作根轨道不能再带人物离开已验证落点。
    def test_delivered_root_tracks_stay_in_place(self):
        manifest = json.loads((ROOT / "internal/assets/provider-animation-manifest.json").read_text())
        for entry in manifest["animations"]:
            path = ROOT / "internal/assets/builtin" / (entry["asset_key"] + ".glb")
            doc, blob = MODULE.read_document(path)
            clip = doc["animations"][0]
            for channel in clip["channels"]:
                name = doc["nodes"][channel["target"]["node"]]["name"]
                if name != "root" or channel["target"]["path"] != "translation":
                    continue
                values = MODULE.read_accessor(doc, blob, clip["samplers"][channel["sampler"]]["output"])
                for axis in (0, 2):
                    self.assertLess(max(row[axis] for row in values) - min(row[axis] for row in values), 0.00001, entry["clip"])

    # 多个源文件共用同一动作时仍保留全部来源，不复制人物网格作为动画包。
    def test_sources_remain_accounted_for(self):
        manifest = json.loads((ROOT / "internal/assets/provider-animation-manifest.json").read_text())
        self.assertEqual(len(manifest["animations"]), len({item["asset_key"] for item in manifest["animations"]}))
        imported = {item["asset_key"] for item in manifest["animations"]}
        for item in manifest["sources"]:
            self.assertIn(item["status"], {"imported", "duplicate", "failed", "excluded-nonhumanoid"})
            if item["status"] in {"imported", "duplicate"}:
                self.assertIn(item["asset_key"], imported)
                self.assertTrue(item["source_sha256"])
                self.assertTrue(item["normalization"])
            else:
                self.assertTrue(item["reason"])


class ProviderAnimationBatchTest(unittest.TestCase):
    """用实际GLB与临时清单验证分批、去重、恢复和失败的持久结果。"""

    # 最小动作夹具包含实际时间与旋转轨道，不依赖源包或Blender。
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.output = self.root / "outputs"
        self.output.mkdir()
        self.manifest = self.root / "manifest.json"
        self.nodes = [{"name": "root"}]
        self.times = [0.0, 1.0]
        self.poses = {"root": {"translation": [(0, 0, 0)] * 2, "rotation": [(0, 0, 0, 1), (0, 0.5, 0, 0.8660254)], "scale": [(1, 1, 1)] * 2}}
        self.canonical = self.root / "canonical.glb"
        MODULE.write_clip(self.canonical, "canonical", self.nodes, [0], self.times, self.poses)
        self.configuration = {"batches": [], "excluded_sources": [], "shared_asset_metadata": {"kaykit": {"source_url": "https://kaylousberg.itch.io/", "license": "CC0-1.0"}, "kenney": {"source_url": "https://kenney.nl/", "license": "CC0-1.0"}}}

    # 每批夹具独立源文件，来源校验值由真实序列化字节取得。
    def source(self, key, clip="walk"):
        path = self.root / (key + ".glb")
        MODULE.write_clip(path, clip, self.nodes, [0], self.times, self.poses)
        source = {"source_file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "provider": "kaykit", "pack_key": "test-pack", "clips": [clip], "source_url": "https://example.test/source", "license": "CC0-1.0"}
        self.configuration["batches"].append({"key": key, "sources": [source]})
        return source

    # 输出变化由实际曲线决定，相同曲线只交付一份GLB但不丢来源。
    def convert(self, sources, poses=None):
        result = (self.times, poses or self.poses, {"method": "fixture-retarget"})
        with patch.object(MODULE, "retarget", return_value=result) as converter:
            report = MODULE.import_sources(self.configuration, sources, self.manifest, self.output, self.canonical)
        return report, converter.call_count

    # 第二批保留第一批，恢复成功项不重新转换或改写既有文件。
    def test_batches_preserve_results_and_resume_validated_outputs(self):
        first = self.source("first")
        second = self.source("second", "run")
        report, calls = self.convert([first])
        self.assertEqual(calls, 1)
        self.assertEqual(report["counts"]["pending_clips"], 1)
        before = {p.name: p.read_bytes() for p in self.output.glob("*.glb")}
        report, calls = self.convert([second])
        self.assertEqual(calls, 1)
        self.assertEqual(len(report["sources"]), 2)
        self.assertEqual(len(report["animations"]), 1)
        self.assertEqual(report["sources"][1]["status"], "duplicate")
        self.assertTrue(report["complete"])
        report, calls = self.convert([first, second])
        self.assertEqual(calls, 0)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.output.glob("*.glb")})
        self.assertEqual(json.loads(self.manifest.read_text()), report)

    # canonical真实节点变更后，分批恢复必须逐条重算并保留旧不可变产物。
    def test_canonical_change_invalidates_each_batch_and_keeps_current_dedup(self):
        first, second = self.source("first"), self.source("second")
        original, _ = self.convert([first, second])
        old_key = original["animations"][0]["asset_key"]
        old_bytes = (self.output/(old_key+".glb")).read_bytes()
        self.canonical.unlink()
        self.nodes[0]["translation"] = [1, 0, 0]
        MODULE.write_clip(self.canonical, "canonical", self.nodes, [0], self.times, self.poses)
        report, calls = self.convert([first])
        self.assertEqual(calls, 1)
        self.assertFalse(report["complete"])
        self.assertEqual(report["counts"]["pending_clips"], 1)
        active = {item["asset_key"] for item in report["sources"] if item["status"] in {"imported", "duplicate"}}
        self.assertEqual({item["asset_key"] for item in report["animations"]}, active)
        self.assertEqual(report["counts"]["unique_clips"], len(active))
        self.assertIn(old_key, {item["key"] for item in report["assets"]})
        report, calls = self.convert([second])
        self.assertEqual(calls, 1)
        self.assertTrue(report["complete"])
        self.assertEqual(report["counts"]["failed_clips"], 0)
        self.assertEqual(len(report["animations"]), 1)
        active = {item["asset_key"] for item in report["sources"] if item["status"] in {"imported", "duplicate"}}
        self.assertEqual({item["asset_key"] for item in report["animations"]}, active)
        self.assertEqual(report["counts"]["unique_clips"], len(active))
        self.assertIn(old_key, {item["key"] for item in report["assets"]})
        self.assertNotEqual(report["animations"][0]["asset_key"], old_key)
        self.assertEqual({item["canonical_sha256"] for item in report["sources"]}, {hashlib.sha256(self.canonical.read_bytes()).hexdigest()})
        self.assertEqual((self.output/(old_key+".glb")).read_bytes(), old_bytes)
        document, _ = MODULE.read_document(self.output/(report["animations"][0]["asset_key"]+".glb"))
        self.assertEqual(document["nodes"][0]["translation"], [1, 0, 0])
        _, calls = self.convert([first, second])
        self.assertEqual(calls, 0)

    # 旧清单没有单条canonical证明，不能用已更新的全局hash替代。
    def test_legacy_records_without_canonical_hash_are_reprocessed(self):
        first, second = self.source("first"), self.source("second")
        report, _ = self.convert([first, second])
        for record in report["sources"]:
            record.pop("canonical_sha256", None)
        self.manifest.write_text(json.dumps(report))
        report, calls = self.convert([first])
        self.assertEqual(calls, 1)
        self.assertFalse(report["complete"])
        report, calls = self.convert([second])
        self.assertEqual(calls, 1)
        self.assertTrue(report["complete"])

    # canonical非骨架内容变化会重新验证，但相同实际节点与轨道仍复用原身份。
    def test_non_skeleton_canonical_change_reuses_identical_payload(self):
        source = self.source("first")
        report, _ = self.convert([source])
        key = report["animations"][0]["asset_key"]
        before = (self.output/(key+".glb")).read_bytes()
        self.canonical.unlink()
        MODULE.write_clip(self.canonical, "canonical metadata changed", self.nodes, [0], self.times, self.poses)
        report, calls = self.convert([source])
        self.assertEqual(calls, 1)
        self.assertTrue(report["complete"])
        self.assertEqual(report["animations"][0]["asset_key"], key)
        self.assertEqual((self.output/(key+".glb")).read_bytes(), before)

    # 新canonical的首批失败不能让下一批继承旧成功；修复后可再次恢复。
    def test_canonical_change_failure_and_interruption_resume(self):
        first, second = self.source("first"), self.source("second")
        self.convert([first, second])
        self.canonical.unlink()
        self.nodes[0]["translation"] = [1, 0, 0]
        MODULE.write_clip(self.canonical, "canonical", self.nodes, [0], self.times, self.poses)
        with patch.object(MODULE, "retarget", side_effect=ValueError("fixture failure")):
            report = MODULE.import_sources(self.configuration, [first], self.manifest, self.output, self.canonical)
        self.assertEqual(report["counts"]["failed_clips"], 1)
        self.assertEqual(report["counts"]["pending_clips"], 1)
        with patch.object(MODULE, "retarget", side_effect=[(self.times, self.poses, {}), KeyboardInterrupt()]):
            with self.assertRaises(KeyboardInterrupt):
                MODULE.import_sources(self.configuration, [first, second], self.manifest, self.output, self.canonical)
        checkpoint = json.loads(self.manifest.read_text())
        self.assertFalse(checkpoint["complete"])
        self.assertEqual(checkpoint["counts"]["pending_clips"], 1)
        report, calls = self.convert([second])
        self.assertEqual(calls, 1)
        self.assertTrue(report["complete"])

    # 坏源会留下失败原因，其他源继续加工，重试只处理失败项。
    def test_partial_failure_keeps_success_and_retry_recovers(self):
        good = self.source("good")
        bad = self.source("bad")
        original = Path(bad["source_file"]).read_bytes()
        Path(bad["source_file"]).write_bytes(b"broken")
        report, calls = self.convert([good, bad])
        self.assertEqual(calls, 1)
        self.assertEqual(report["counts"]["failed_clips"], 1)
        self.assertFalse(report["complete"])
        self.assertEqual(len(report["animations"]), 1)
        Path(bad["source_file"]).write_bytes(original)
        report, calls = self.convert([good, bad])
        self.assertEqual(calls, 1)
        self.assertEqual(report["counts"]["failed_clips"], 0)
        self.assertTrue(report["complete"])

    # 已有资源损坏时禁止把它继续算成功，也不能覆写不同字节的不可变身份。
    def test_corrupted_delivery_is_reported_without_overwrite(self):
        source = self.source("first")
        report, _ = self.convert([source])
        output = self.output / (report["animations"][0]["asset_key"] + ".glb")
        output.write_bytes(b"corrupted")
        report, _ = self.convert([source])
        self.assertEqual(report["counts"]["failed_clips"], 1)
        self.assertEqual(output.read_bytes(), b"corrupted")

    # 显式来源清单不会因为骨名相同而导入幽灵或平台怪物。
    def test_selection_requires_reviewed_batch_and_source(self):
        first = self.source("first")
        self.source("second")
        self.assertEqual(MODULE.select_sources(self.configuration, ["first"], []), [first])
        with self.assertRaises(ValueError):
            MODULE.select_sources(self.configuration, ["unknown"], [])
        with self.assertRaises(ValueError):
            MODULE.select_sources(self.configuration, ["first"], ["unreviewed-ghost.glb"])
        production = json.loads((ROOT / "scripts/provider-animation-sources.json").read_text())
        paths = [item["source_file"] for batch in production["batches"] for item in batch["sources"]]
        self.assertFalse(any("character-ghost.glb" in path or "/platformer-kit/" in path for path in paths))

    # CLI使用真实坏源写失败清单并返回非零，不会成功退出冒充交付完成。
    def test_cli_failure_is_nonzero_and_preserves_failure_report(self):
        source = self.source("bad")
        Path(source["source_file"]).write_bytes(b"broken")
        configuration = self.root / "sources.json"
        self.configuration["content"] = {"description": "fixture", "select_batch": "select"}
        configuration.write_text(json.dumps(self.configuration))
        result = subprocess.run([sys.executable, str(ROOT / "scripts/import-provider-animations.py"), "--batch", "bad", "--sources", str(configuration), "--manifest", str(self.manifest), "--output", str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        report = json.loads(self.manifest.read_text())
        self.assertEqual(report["counts"]["failed_clips"], 1)
        self.assertFalse(report["complete"])

    # FBX语义映射包含实际四肢关节，不把辅助控制骨当手脚。
    def test_fbx_joint_mapping_uses_reviewed_humanoid_bones(self):
        names = ["Root", "Hips", "Spine", "Chest", "Head", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot", "LeftToes", "RightToes", "LeftFootCtrl"]
        mapping, profile = MODULE.bone_mapping({"nodes": [{"name": name} for name in names]})
        self.assertEqual(profile, "kenney-fbx-humanoid")
        self.assertEqual(names[mapping["lowerleg.l"]], "LeftLeg")
        self.assertEqual(names[mapping["foot.l"]], "LeftFoot")
        self.assertNotIn(names.index("LeftFootCtrl"), mapping.values())

    # 两个空工作区反序处理同曲线，必须交付相同字节和共享定义，许可仍逐源保留。
    def test_dedup_is_independent_of_source_order_and_preserves_provenance(self):
        first, second = self.source("first", "walk"), self.source("second", "run")
        second.update(pack_key="another-pack", source_url="https://example.test/other")
        outcomes = []
        for index, sources in enumerate([[first, second], [second, first]]):
            directory = self.root/("order-"+str(index))
            with patch.object(MODULE, "retarget", return_value=(self.times, self.poses, {})):
                report = MODULE.import_sources(self.configuration, sources, self.root/("order-"+str(index)+".json"), directory, self.canonical)
            self.assertTrue(report["complete"])
            self.assertEqual(len(report["animations"]), 1)
            key = report["animations"][0]["asset_key"]
            self.assertEqual(report["assets"][0]["source_url"], "https://kaylousberg.itch.io/")
            self.assertEqual(report["assets"][0]["license"], "CC0-1.0")
            self.assertNotIn("pack_key", report["assets"][0])
            outcomes.append((report["assets"], report["animations"], (directory/(key+".glb")).read_bytes()))
            for source in [first, second]:
                record = next(item for item in report["sources"] if item["source_file"] == source["source_file"])
                for field in ['provider', 'pack_key', 'source_url', 'license']:
                    self.assertEqual(record[field], source[field])
                self.assertEqual(record['source_clip'], source['clips'][0])
        self.assertEqual(outcomes[0], outcomes[1])

    # 不同作者来源族不能共用一个带单一出处的资源身份。
    def test_different_source_families_keep_distinct_provenance(self):
        first, second = self.source("first"), self.source("second")
        second['provider'] = 'kenney'
        report, _ = self.convert([first, second])
        self.assertTrue(report['complete'])
        self.assertEqual(len(report['assets']), 2)
        self.assertEqual({item['provider'] for item in report['assets']}, {'kaykit', 'kenney'})
        self.assertEqual({item['source_url'] for item in report['assets']}, {'https://kaylousberg.itch.io/', 'https://kenney.nl/'})

    # 来源许可不能被共享族配置伪标；改变族出处也必须使用新身份。
    def test_shared_family_metadata_is_validated_and_part_of_identity(self):
        source = self.source("first")
        source['license'] = 'CC-BY-4.0'
        report, calls = self.convert([source])
        self.assertEqual(calls, 0)
        self.assertEqual(report['counts']['failed_clips'], 1)
        self.assertEqual(report['assets'], [])
        source['license'] = 'CC0-1.0'
        report, _ = self.convert([source])
        old_key = report['assets'][0]['key']
        self.configuration['shared_asset_metadata']['kaykit']['source_url'] = 'https://example.test/updated-family'
        # 这次配方变化必须重新加工，不能沿用先前缓存的共享定义。
        report, calls = self.convert([source])
        self.assertEqual(calls, 1)
        active_key = report['animations'][0]['asset_key']
        self.assertNotEqual(active_key, old_key)
        active_asset = next(item for item in report['assets'] if item['key'] == active_key)
        self.assertEqual(active_asset['source_url'], 'https://example.test/updated-family')
        self.assertIn(old_key, {item['key'] for item in report['assets']})

    # 数值相同的曲线具有稳定身份，与源片段的显示名无关。
    def test_curve_identity_is_stable(self):
        self.assertEqual(MODULE.curve_signature(self.times, self.poses), MODULE.curve_signature(list(self.times), dict(self.poses)))
        changed = json.loads(json.dumps(self.poses))
        changed["root"]["rotation"][1][1] += 0.1
        self.assertNotEqual(MODULE.curve_signature(self.times, self.poses), MODULE.curve_signature(self.times, changed))


if __name__ == "__main__":
    unittest.main()
