"""在实际模型与动作上检查弓手红斜带的闭面内部，边缘接触另行记录。"""

import argparse
from collections import defaultdict
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


# 载入共享制作或检查模块，不运行其命令行。
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 报告记录实际文件身份，而不是沿用旧版本的名称。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 身体求值三角面用于近点方向与闭面内外判断。
def surface(objects):
    points, triangles = [], []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(points)
        points.extend(evaluated.matrix_world @ vertex.co for vertex in mesh.vertices)
        triangles.extend(
            tuple(offset + i for i in tri.vertices) for tri in mesh.loop_triangles
        )
        evaluated.to_mesh_clear()
    return BVHTree.FromPolygons(points, triangles, all_triangles=True)


# 红带检查只使用同侧胸肩体，阅读中移到面前的前臂和手属于合法前景遮挡。
def shoulder_surface(objects):
    points, triangles = [], []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(points)
        points.extend(evaluated.matrix_world @ vertex.co for vertex in mesh.vertices)
        for tri in mesh.loop_triangles:
            rest_points = [
                obj.matrix_world @ obj.data.vertices[index].co for index in tri.vertices
            ]
            center = sum(rest_points, Vector()) / 3
            if not (-0.65 < center.x < -0.1 and 0.90 < center.z < 1.30):
                continue
            weights = [
                {
                    obj.vertex_groups[group.group].name: group.weight
                    for group in obj.data.vertices[index].groups
                }
                for index in tri.vertices
            ]
            if any(
                any(
                    value > 0.05 and name not in ["chest", "spine", "upperarm.r"]
                    for name, value in row.items()
                )
                for row in weights
            ):
                continue
            triangles.append(tuple(offset + index for index in tri.vertices))
        evaluated.to_mesh_clear()
    if not triangles:
        raise ValueError("未取得实际同侧胸肩碰撞表面")
    return BVHTree.FromPolygons(points, triangles, all_triangles=True)


# 拓扑、UV、材质和权重是允许位置适配之外的受保护来源属性。
def attributes(obj):
    mesh = obj.data
    return {
        "topology": [list(face.vertices) for face in mesh.polygons],
        "uv": [[list(value.uv) for value in layer.data] for layer in mesh.uv_layers],
        "material_indices": [face.material_index for face in mesh.polygons],
        "materials": [(m.name, list(m.diffuse_color)) for m in mesh.materials],
        "weights": [
            [(obj.vertex_groups[g.group].name, g.weight) for g in v.groups]
            for v in mesh.vertices
        ],
    }


# 选取实际红带躯干片的上肩闭面，手腕和手套不进入检查域。
def shoulder_faces(obj, fitting, rig):
    components = fitting.select_components(
        fitting.mesh_components(obj),
        {"materials": ["BrownDark"], "bone_region": "torso"},
        rig,
    )
    faces = {index for component in components for index in component["faces"]}
    chosen = []
    for index in sorted(faces):
        face = obj.data.polygons[index]
        points = [obj.matrix_world @ obj.data.vertices[i].co for i in face.vertices]
        center = sum(points, Vector()) / len(points)
        normal = (points[1] - points[0]).cross(points[2] - points[0]).normalized()
        radial = Vector((center.x, center.y, 0)).normalized()
        if center.z > 0.98 and abs(center.x) > 0.20 and normal.dot(radial) > 0.2:
            chosen.append(index)
    return chosen, {
        index for component in components for index in component["vertices"]
    }


# 来源有面积的红带面板与其真实封边接口分别登记，UV退化本身不代表几何没有接触。
def panel_domain(obj, fitting, rig):
    components = fitting.select_components(
        fitting.mesh_components(obj),
        {"materials": ["BrownDark"], "bone_region": "torso"},
        rig,
    )
    source_faces = {index for component in components for index in component["faces"]}
    panels, edges = set(), defaultdict(list)
    for index in sorted(source_faces):
        face = obj.data.polygons[index]
        uvs = [obj.data.uv_layers.active.data[loop].uv for loop in face.loop_indices]
        area = (
            abs(sum(a.x * b.y - a.y * b.x for a, b in zip(uvs, uvs[1:] + uvs[:1]))) / 2
        )
        if area > 1e-8:
            panels.add(index)
        vertices = list(face.vertices)
        for a, b in zip(vertices, vertices[1:] + vertices[:1]):
            key = tuple(
                sorted(
                    [
                        tuple(round(v, 5) for v in obj.data.vertices[a].co),
                        tuple(round(v, 5) for v in obj.data.vertices[b].co),
                    ]
                )
            )
            edges[key].append((index, a, b))
    rims = []
    for neighbors in edges.values():
        panel_neighbors = [row for row in neighbors if row[0] in panels]
        if panel_neighbors and (
            len(neighbors) == 1 or any(row[0] not in panels for row in neighbors)
        ):
            face, a, b = panel_neighbors[0]
            rims.append(
                {
                    "vertices": [a, b],
                    "panel": face,
                    "neighbors": [row[0] for row in neighbors],
                }
            )
    return panels, rims


# 固定来源边在实际蒙皮动作中求值，距离不按旧静止画面猜测。
def posed_rims(obj, rims):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    segments = [
        (
            evaluated.matrix_world @ mesh.vertices[row["vertices"][0]].co,
            evaluated.matrix_world @ mesh.vertices[row["vertices"][1]].co,
        )
        for row in rims
    ]
    evaluated.to_mesh_clear()
    return segments


# 点到有限边段的实际三维距离区分面板内部与紧邻折边的位置。
def edge_distance(point, segments):
    result = float("inf")
    for a, b in segments:
        axis = b - a
        fraction = (
            max(0, min(1, (point - a).dot(axis) / axis.length_squared))
            if axis.length_squared
            else 0
        )
        result = min(result, (point - (a + axis * fraction)).length)
    return result


# 原面上的内侧重心网格避开外轮廓，不能把正常开领边缘当成闭面内部。
def closed_samples(obj, faces):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    result = []
    for tri in mesh.loop_triangles:
        if tri.polygon_index not in faces:
            continue
        points = [evaluated.matrix_world @ mesh.vertices[i].co for i in tri.vertices]
        normal = (points[1] - points[0]).cross(points[2] - points[0]).normalized()
        for a in range(1, 12):
            for b in range(1, 12 - a):
                weights = (a / 12, b / 12, 1 - (a + b) / 12)
                point = sum((p * w for p, w in zip(points, weights)), Vector())
                result.append((tri.polygon_index, point, normal))
    evaluated.to_mesh_clear()
    return result


# 四个既定肩部外部视角只检查首个可见衣面，内层衬片另行保留诊断。
def external_witness(point, body_tree, cloth_tree, solid_tree):
    witnesses, foreground, inner_wall = [], [], []
    for x, y in [(-0.5, -1), (-0.5, 1), (0.5, -1), (0.5, 1)]:
        direction = Vector((x, y, 0.2)).normalized()
        origin = point + direction * 2
        cloth = cloth_tree.ray_cast(origin, -direction, 2.1)
        body = body_tree.ray_cast(origin, -direction, 2.1)
        if cloth[0] is None or abs(cloth[3] - 2) > 0.001:
            continue
        if body[0] is not None and body[3] < cloth[3] - 0.0005:
            if cloth[1].dot(direction) <= 0:
                inner_wall.append(
                    {
                        "direction": list(direction),
                        "cloth_normal_dot_view": cloth[1].dot(direction),
                        "body_lead": cloth[3] - body[3],
                    }
                )
                continue
            crossings = []
            cursor = origin.copy()
            travelled = 0.0
            for _ in range(32):
                hit = solid_tree.ray_cast(cursor, -direction, 2 - travelled)
                if hit[0] is None:
                    break
                travelled += hit[3]
                crossings.append(
                    {"distance": travelled, "normal_dot_ray": hit[1].dot(-direction)}
                )
                cursor = hit[0] - direction * 0.00001
                travelled += 0.00001
                if travelled >= 1.9995:
                    break
            # 最后穿越为出体面时，骨体的进入和离开都在衣面之前，属于前景。
            winding = sum(1 if row["normal_dot_ray"] < 0 else -1 for row in crossings)
            if crossings and winding <= 0:
                foreground.append(
                    {
                        "direction": list(direction),
                        "body_crossings_before_cloth": crossings,
                        "cloth_distance": cloth[3],
                    }
                )
                continue
            witnesses.append(
                {
                    "direction": list(direction),
                    "body_lead": cloth[3] - body[3],
                    "body_crossings_before_cloth": crossings,
                }
            )
    return witnesses, foreground, inner_wall


# 近点法线相交与外部可见穿出分别记录，避免把内衬当作外表闭面。
def measure(samples, body_tree, cloth_tree, panels=None, rims=(), solid_tree=None):
    records = []
    for face, point, normal in samples:
        near, body_normal, _, distance = body_tree.find_nearest(point)
        signed = (point - near).dot(body_normal)
        origin = point + normal * 0.5
        body_hit = body_tree.ray_cast(origin, -normal, 1.5)
        cloth_hit = cloth_tree.ray_cast(origin, -normal, 1.5)
        body_visible = body_hit[0] is not None and (
            cloth_hit[0] is None or body_hit[3] < cloth_hit[3] - 0.0005
        )
        normal_exposed = signed < -0.0005 and distance < 0.06 and body_visible
        witnesses, foreground, inner_wall = (
            external_witness(point, body_tree, cloth_tree, solid_tree or body_tree)
            if signed < -0.0005
            else ([], [], [])
        )
        exposed = bool(witnesses)
        rim_distance = (
            edge_distance(point, rims) if (exposed or normal_exposed) and rims else None
        )
        panel_failure = exposed and (
            panels is None
            or (face in panels and rim_distance is not None and rim_distance >= 0.004)
        )
        records.append(
            {
                "face": face,
                "point": list(point),
                "signed_body_distance": signed,
                "nearest_distance": distance,
                "penetrating": exposed,
                "normal_ray_intersection": normal_exposed,
                "external_witnesses": witnesses,
                "foreground_body_intervals": foreground,
                "backfacing_inner_wall_observations": inner_wall,
                "panel_failure": panel_failure,
                "panel_face": None if panels is None else face in panels,
                "source_rim_distance": rim_distance,
                "body_ray_distance": body_hit[3],
                "cloth_ray_distance": cloth_hit[3],
            }
        )
    return records


class ArcherShoulderActualGLBTest(unittest.TestCase):
    """红带的闭面内部不能被肩部皮肤或骨体穿出。"""

    # 既定两身体八姿态同时回归位置适配与其他来源部位保持。
    def test_actual_closed_shoulder(self):
        assembly_path = ROOT / "scripts/verify-modular-character-appearance.py"
        arm_path = ROOT / "scripts/verify-modular-character-arms.py"
        tool_paths = [
            Path(__file__),
            OPTIONS.fitting_tool,
            assembly_path,
            arm_path,
            ROOT / "scripts/asset-pipeline-rules.json",
        ]
        producer = {str(path.resolve()): sha(path) for path in tool_paths}
        assembly = load("archer_shoulder_assembly", assembly_path)
        arm = load("archer_shoulder_arm", arm_path)
        fitting = load("archer_shoulder_fitting", OPTIONS.fitting_tool)
        catalog = json.loads(OPTIONS.catalog.read_text())
        bodies = {row["character_key"]: row for row in catalog["characters"]}
        wearables = {row["wearable_key"]: row for row in catalog["wearables"]}
        settings = json.loads(OPTIONS.settings.read_text())
        poses = [
            (p["motion"], p["frame"])
            for p in json.loads(
                (ROOT / "scripts/asset-pipeline-rules.json").read_text()
            )["sampling"]["poses"]
        ]
        report = {
            "mode": "apply-fit-and-check"
            if OPTIONS.apply
            else "verify-existing-geometry",
            "fit_applied": OPTIONS.apply,
            "catalog_sha256": sha(OPTIONS.catalog),
            "settings_sha256": sha(OPTIONS.settings),
            "producer_sources": producer,
            "inputs": {},
            "cases": [],
        }
        failures = []
        for body_key in bodies:
            paths = {}
            body, rig, selected, hashes, selection, sources = assembly.load_appearance(
                {
                    "body": body_key,
                    "selection": {"upper": "kaykit-legacy-skeleton-archer-upper"},
                },
                bodies,
                wearables,
                OPTIONS.asset_directory,
                paths,
            )
            item = wearables[selection["upper"]]
            cloth = sources[item["model_asset_key"]][item["nodes"][0]]
            faces, target_vertices = shoulder_faces(cloth, fitting, rig)
            panels, rims = panel_domain(cloth, fitting, rig)
            self.assertTrue(faces, "本次模型必须包含实际红带闭面")
            before = attributes(cloth)
            positions = [v.co.copy() for v in cloth.data.vertices]
            operation = (
                fitting.fit_upper_clothing([cloth], rig, settings)
                if OPTIONS.apply
                else None
            )
            self.assertEqual(before, attributes(cloth), "位置之外的来源属性不得变化")
            changed = {
                v.index
                for v, p in zip(cloth.data.vertices, positions)
                if (v.co - p).length > 1e-8
            }
            self.assertFalse(changed - target_vertices, "其他衣片、手腕或手套不得变化")
            protected_lower = {
                i for i, p in enumerate(positions) if (cloth.matrix_world @ p).z <= 0.96
            }
            self.assertFalse(
                changed & protected_lower, "红带下方不属于本次上肩适配范围"
            )
            collider = [
                obj
                for obj in selected
                if obj in sources[body["model_asset_key"]].values()
            ]
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
                records = measure(
                    closed_samples(cloth, set(faces)),
                    shoulder_surface(collider),
                    surface([cloth]),
                    panels,
                    posed_rims(cloth, rims),
                    surface(collider),
                )
                penetrating = [row for row in records if row["panel_failure"]]
                rim_contacts = [
                    row
                    for row in records
                    if row["penetrating"] and not row["panel_failure"]
                ]
                case = {
                    "body": body_key,
                    "motion": motion,
                    "frame": frame,
                    "samples": len(records),
                    "penetrating": len(penetrating),
                    "closed_panel_exposed": len(penetrating),
                    "source_rim_contacts": len(rim_contacts),
                    "normal_only_intersections": sum(
                        row["normal_ray_intersection"] and not row["penetrating"]
                        for row in records
                    ),
                    "closed_panel_margin": 0.004,
                    "maximum_penetration": max(
                        (-p["signed_body_distance"] for p in penetrating), default=0
                    ),
                    "source_attributes_preserved": True if OPTIONS.apply else None,
                    "attributes_unchanged_during_test": True,
                    "protected_other_vertices": len(positions) - len(target_vertices),
                    "changed_vertices": len(changed),
                    "operation": operation,
                    "records": records,
                }
                report["cases"].append(case)
                if penetrating:
                    failures.append(
                        {
                            key: case[key]
                            for key in [
                                "body",
                                "motion",
                                "frame",
                                "penetrating",
                                "maximum_penetration",
                            ]
                        }
                    )
            if OPTIONS.candidate_output and OPTIONS.apply:
                arm.apply_pose(bpy, rig, body, actions, "rest", 0)
                bpy.ops.object.select_all(action="DESELECT")
                cloth.select_set(True)
                rig.select_set(True)
                bpy.context.view_layer.objects.active = rig
                target = OPTIONS.candidate_output / (body_key + "--archer-shoulder.glb")
                target.parent.mkdir(parents=True, exist_ok=True)
                bpy.ops.export_scene.gltf(
                    filepath=str(target),
                    export_format="GLB",
                    use_selection=True,
                    export_animations=False,
                    export_skins=True,
                    export_def_bones=False,
                )
        drift = [
            str(path)
            for path in tool_paths
            if sha(path) != producer[str(path.resolve())]
        ]
        report.update(
            status="failed" if failures or drift else "passed",
            failures=failures,
            producer_drift=drift,
            summary={
                "cases": len(report["cases"]),
                "samples": sum(c["samples"] for c in report["cases"]),
                "penetrating": sum(c["penetrating"] for c in report["cases"]),
                "source_rim_contacts": sum(
                    c["source_rim_contacts"] for c in report["cases"]
                ),
            },
        )
        OPTIONS.report.parent.mkdir(parents=True, exist_ok=True)
        OPTIONS.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
        self.assertFalse(drift, "检查期间工具发生变化")
        self.assertFalse(failures, json.dumps(failures, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--asset-directory", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--fitting-tool",
        type=Path,
        default=ROOT / "scripts/modular-character-clothing-fit.py",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--candidate-output", type=Path)
    OPTIONS = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ArcherShoulderActualGLBTest)
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
