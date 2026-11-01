"""以正式交付的 GLB 验证原始人物动作，而不是只核对旁边的清单。"""

import importlib.util
import json
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
            self.assertEqual(assets[entry["asset_key"]]["kind"], "animation")

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


if __name__ == "__main__":
    unittest.main()
