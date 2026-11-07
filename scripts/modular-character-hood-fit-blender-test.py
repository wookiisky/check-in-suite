"""以实际兜帽闭面及两种身体的交付动作检查颊部穿透。"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]


# 复用真实组装入口，不运行其命令行。
def load(name, filename):
    specification = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / filename
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


# 所有结论绑定本次实际文件字节。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 从求值网格建立真实三角面射线树。
def surface(objects):
    graph = bpy.context.evaluated_depsgraph_get()
    points = []
    triangles = []
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(points)
        points.extend(evaluated.matrix_world @ vertex.co for vertex in mesh.vertices)
        triangles.extend(
            tuple(offset + index for index in triangle.vertices)
            for triangle in mesh.loop_triangles
        )
        evaluated.to_mesh_clear()
    return BVHTree.FromPolygons(points, triangles, all_triangles=True)


# 只取来源确有衣面的颊部与低于眼部开口的面罩；不把天然眼孔当闭面。
def source_samples(obj):
    samples = []
    obj.data.calc_loop_triangles()
    for triangle in obj.data.loop_triangles:
        layer = obj.data.uv_layers.active
        uv = sum((layer.data[index].uv for index in triangle.loops), Vector((0, 0))) / 3
        if not (0 <= uv.x < 0.25 and 0 <= uv.y < 0.75):
            continue
        points = [
            obj.matrix_world @ obj.data.vertices[index].co
            for index in triangle.vertices
        ]
        candidates = [sum(points, Vector()) / 3] + [
            points[i] * 0.6 + points[(i + 1) % 3] * 0.2 + points[(i + 2) % 3] * 0.2
            for i in range(3)
        ]
        for point in candidates:
            cheek = abs(point.x) > 0.25 and 1.30 < point.z < 2.125
            mask = point.y < -0.2 and 1.30 < point.z < 1.52
            posterior = point.y > 0.2 and 1.30 < point.z < 2.125
            if cheek or mask or posterior:
                radial = Vector((point.x, point.y, 0)).normalized()
                normal = (
                    (points[1] - points[0]).cross(points[2] - points[0]).normalized()
                )
                if normal.dot(radial) > 0.15:
                    samples.append(point)
    return list(
        {tuple(round(value, 7) for value in point): point for point in samples}.values()
    )


# 保持原拓扑的当前衣面采样随实际头骨姿态移动，不把适配后的自然眼孔算作闭面。
def probes(rig, samples, hood, face):
    bone = rig.data.bones["head"]
    pose = rig.pose.bones["head"]
    deform = (
        rig.matrix_world
        @ pose.matrix
        @ bone.matrix_local.inverted()
        @ rig.matrix_world.inverted()
        if rig.data.pose_position != "REST"
        else __import__("mathutils").Matrix.Identity(4)
    )
    axis = rig.matrix_world @ bone.tail_local
    records = []
    for index, point in enumerate(samples):
        radial = Vector((point.x - axis.x, point.y - axis.y, 0)).normalized()
        origin = deform @ (point + radial * 0.7)
        direction = (deform.to_3x3() @ (-radial)).normalized()
        cloth = hood.ray_cast(origin, direction, 2)
        skin = face.ray_cast(origin, direction, 2)
        exposed = skin[0] is not None and (
            cloth[0] is None or skin[3] < cloth[3] - 0.0001
        )
        records.append(
            {
                "sample": index,
                "cloth_distance": cloth[3],
                "face_distance": skin[3],
                "exposed": exposed,
                "clearance": skin[3] - cloth[3]
                if skin[3] is not None and cloth[3] is not None
                else None,
            }
        )
    return records


class HoodActualGLBTest(unittest.TestCase):
    """兜帽闭面不能被实际选中脸壳穿出。"""

    # 两身体及八个交付姿态以同一固定来源衣面域复现和回归。
    def test_hood_closed_cheeks(self):
        tool_paths = [
            ROOT / "scripts" / name
            for name in [
                Path(__file__).name,
                "modular-character-hood-fit.py",
                "verify-modular-character-appearance.py",
                "verify-modular-character-arms.py",
                "modular-character-back-fit-blender-test.py",
                "asset-pipeline-rules.json",
            ]
        ]
        producer_sources = {str(path): sha(path) for path in tool_paths}
        assembly = load("hood_test_assembly", "verify-modular-character-appearance.py")
        arm = load("hood_test_arm", "verify-modular-character-arms.py")
        fit = load("hood_test_fit", "modular-character-hood-fit.py")
        attributes = load(
            "hood_test_attributes", "modular-character-back-fit-blender-test.py"
        ).attributes
        catalog = json.loads(OPTIONS.catalog.read_text())
        bodies = {item["character_key"]: item for item in catalog["characters"]}
        wearables = {item["wearable_key"]: item for item in catalog["wearables"]}
        settings = json.loads(OPTIONS.settings.read_text())
        poses = [
            (item["motion"], item["frame"])
            for item in json.loads(
                (ROOT / "scripts/asset-pipeline-rules.json").read_text()
            )["sampling"]["poses"]
        ]
        report = {
            "mode": "verify-existing-fit"
            if OPTIONS.verify_only
            else ("baseline" if OPTIONS.baseline else "fit-and-check"),
            "settings": settings,
            "catalog_sha256": sha(OPTIONS.catalog),
            "settings_sha256": sha(OPTIONS.settings),
            "producer_sources": producer_sources,
            "cases": [],
            "inputs": {},
            "status": "running",
        }
        failures = []
        pairs = [
            (body_key, face_key)
            for body_key, body in bodies.items()
            for face_key in (
                [
                    item["wearable_key"]
                    for item in catalog["wearables"]
                    if item["slot"] == "face"
                ]
                if OPTIONS.all_faces
                else [body["defaults"]["face"]]
            )
        ]
        for body_key, face_key in pairs:
            paths = {}
            body, rig, selected, hashes, selection, sources = assembly.load_appearance(
                {
                    "body": body_key,
                    "selection": {
                        "head": "kaykit-adventurers-rogue-hooded-head",
                        "face": face_key,
                    },
                },
                bodies,
                wearables,
                OPTIONS.asset_directory,
                paths,
            )
            hood = sources[wearables[selection["head"]]["model_asset_key"]][
                "head_provider"
            ]
            face_item = wearables[selection["face"]]
            face = [
                sources[face_item["model_asset_key"]][name]
                for name in face_item["nodes"]
                if not sources[face_item["model_asset_key"]][name].hide_render
            ]
            samples = source_samples(hood)
            self.assertTrue(samples)
            before = attributes(hood)
            positions = [vertex.co.copy() for vertex in hood.data.vertices]
            bone_matrices = [
                list(row) for bone in rig.data.bones for row in bone.matrix_local
            ]
            operation = (
                {"method": "not-applied"}
                if OPTIONS.baseline or OPTIONS.verify_only
                else fit.fit_hood_cheeks(hood, rig, settings)
            )
            self.assertEqual(before, attributes(hood))
            self.assertEqual(
                bone_matrices,
                [list(row) for bone in rig.data.bones for row in bone.matrix_local],
            )
            changed = {
                vertex.index
                for vertex, point in zip(hood.data.vertices, positions)
                if (vertex.co - point).length > 1e-8
            }
            if not OPTIONS.baseline and not OPTIONS.verify_only:
                self.assertEqual(changed, set(operation["moved_vertices"]))
            uv_layer = hood.data.uv_layers.active
            cloth = set()
            hair = set()
            for polygon in hood.data.polygons:
                uv = sum(
                    (uv_layer.data[index].uv for index in polygon.loop_indices),
                    Vector((0, 0)),
                ) / len(polygon.loop_indices)
                (cloth if 0 <= uv.x < 0.25 and 0 <= uv.y < 0.75 else hair).update(
                    polygon.vertices
                )
            protected = hair - cloth
            self.assertTrue(protected)
            self.assertFalse(changed & protected, "棕发源顶点不应随绿色帽壳移动")
            samples = source_samples(hood)
            actions = arm.load_actions(
                bpy, body, hashes, OPTIONS.asset_directory, paths, poses
            )
            report["inputs"].update(
                {
                    key: {"path": paths[key], "sha256": value}
                    for key, value in hashes.items()
                }
            )
            for motion, frame in poses:
                arm.apply_pose(bpy, rig, body, actions, motion, frame)
                records = probes(rig, samples, surface([hood]), surface(face))
                exposed = sum(item["exposed"] for item in records)
                entry = {
                    "body": body_key,
                    "face": face_key,
                    "motion": motion,
                    "frame": frame,
                    "samples": len(records),
                    "exposed": exposed,
                    "minimum_clearance": min(
                        (
                            item["clearance"]
                            for item in records
                            if item["clearance"] is not None
                        ),
                        default=None,
                    ),
                    "operation": operation,
                    "source_attributes_preserved": None
                    if OPTIONS.verify_only
                    else True,
                    "attributes_unchanged_during_test": True,
                    "bone_matrices_preserved": True,
                    "protected_hair_vertices": len(protected),
                    "source_vertices": len(hood.data.vertices),
                    "source_faces": len(hood.data.polygons),
                    "details": records,
                }
                report["cases"].append(entry)
                if exposed:
                    failures.append(
                        {
                            key: entry[key]
                            for key in [
                                "body",
                                "face",
                                "motion",
                                "frame",
                                "exposed",
                                "minimum_clearance",
                            ]
                        }
                    )
            if (
                OPTIONS.candidate_output
                and not OPTIONS.baseline
                and not OPTIONS.verify_only
                and face_key == body["defaults"]["face"]
            ):
                arm.apply_pose(bpy, rig, body, actions, "rest", 0)
                bpy.ops.object.select_all(action="DESELECT")
                hood.select_set(True)
                rig.select_set(True)
                bpy.context.view_layer.objects.active = rig
                path = OPTIONS.candidate_output / (body_key + "--hood.glb")
                path.parent.mkdir(parents=True, exist_ok=True)
                bpy.ops.export_scene.gltf(
                    filepath=str(path),
                    export_format="GLB",
                    use_selection=True,
                    export_animations=False,
                    export_skins=True,
                    export_def_bones=False,
                )
        source_drift = [
            str(path) for path in tool_paths if sha(path) != producer_sources[str(path)]
        ]
        report.update(
            status="failed" if failures or source_drift else "passed",
            producer_drift=source_drift,
            failures=failures,
            summary={
                "cases": len(report["cases"]),
                "samples": sum(item["samples"] for item in report["cases"]),
                "exposed": sum(item["exposed"] for item in report["cases"]),
            },
        )
        OPTIONS.report.parent.mkdir(parents=True, exist_ok=True)
        OPTIONS.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
        self.assertFalse(source_drift, "检查期间工具来源发生变化")
        self.assertFalse(failures, json.dumps(failures, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--asset-directory", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--candidate-output", type=Path)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--all-faces", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    OPTIONS = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(HoodActualGLBTest)
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
