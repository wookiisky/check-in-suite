"""冻结V8复现裤形残留，并验证独立裸腰候选的八姿势与保护部位。"""

from pathlib import Path
from collections import Counter
import argparse
import hashlib
import importlib.util
import json
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

R = Path(__file__).resolve().parents[1]


# 使用现有真实动作加载器，不替代骨架求值。
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, R / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 快照完整节点数据；新髋壳之外不应变化。
def snapshot(obj):
    return {
        "points": [tuple(v.co) for v in obj.data.vertices],
        "weights": [
            {obj.vertex_groups[g.group].name: g.weight for g in v.groups}
            for v in obj.data.vertices
        ],
        "faces": [tuple(p.vertices) for p in obj.data.polygons],
        "uv": [tuple(v.uv) for v in obj.data.uv_layers.active.data]
        if obj.data.uv_layers.active
        else [],
        "normals": [tuple(n.vector) for n in obj.data.corner_normals],
    }


# 只按三角面实际位置建树，保留原组件边界用于验证重叠。
def surface(obj, indices):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    points = [evaluated.matrix_world @ v.co for v in mesh.vertices]
    triangles = [
        tuple(t.vertices) for t in mesh.loop_triangles if t.polygon_index in indices
    ]
    evaluated.to_mesh_clear()
    return BVHTree.FromPolygons(points, triangles, all_triangles=True), points


# 用真实绑定点对应的重复接口比较动作求值位置，不以包络推断闭合。
def run(options):
    fix = load("human_waist_fix", "modular-character-human-waist-fit.py")
    arm = load("human_waist_arm", "verify-modular-character-arms.py")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(options.baseline_input))
    baseline = bpy.data.objects["body_legs"]
    expected_waist = {
        tuple(round(float(v), 6) for v in baseline.matrix_world @ vertex.co): {
            baseline.vertex_groups[g.group].name: g.weight for g in vertex.groups
        }
        for vertex in baseline.data.vertices
        if abs((baseline.matrix_world @ vertex.co).z - 0.72) < 1e-5
    }
    assert len(expected_waist) >= 8, "冻结V8腰口参考缺失"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(options.input))
    rig = next(x for x in bpy.data.objects if x.type == "ARMATURE")
    objects = {x.name: x for x in bpy.data.objects if x.type == "MESH"}
    legs = objects["body_legs"]
    torso = objects["body_torso"]
    protected = {
        name: snapshot(obj) for name, obj in objects.items() if name != "body_legs"
    }
    old = snapshot(legs)
    # source小腿权重定义保护域，避免复用制作器的连通件索引判断。
    keep = [
        i
        for i, weights in enumerate(old["weights"])
        if any(
            name.startswith(("upperleg.", "lowerleg.", "foot.", "toes.")) and weight > 0
            for name, weight in weights.items()
        )
    ]
    settings = json.loads(options.settings.read_text())
    evidence = (
        fix.fit_human_waist(objects, rig, settings) if options.apply_fix else None
    )
    if options.apply_fix:
        after = snapshot(legs)
        assert after["points"][: len(keep)] == [old["points"][i] for i in keep], (
            "修改原腿筒顶点"
        )
        assert after["weights"][: len(keep)] == [old["weights"][i] for i in keep], (
            "修改原腿筒蒙皮"
        )
        mapping = {index: new for new, index in enumerate(keep)}
        source_faces = [
            face for face in old["faces"] if all(index in mapping for index in face)
        ]
        assert after["faces"][: len(source_faces)] == [
            tuple(mapping[index] for index in face) for face in source_faces
        ], "修改原腿筒面"
        source_mesh_uv = []
        source_normals = []
        offset = 0
        for face in old["faces"]:
            if all(index in mapping for index in face):
                source_mesh_uv.extend(old["uv"][offset : offset + len(face)])
                source_normals.extend(old["normals"][offset : offset + len(face)])
            offset += len(face)
        assert after["uv"][: len(source_mesh_uv)] == source_mesh_uv, "修改原腿筒UV"
        normal_errors = [
            sum((a - b) ** 2 for a, b in zip(first, second))
            for first, second in zip(source_normals, after["normals"])
        ]
        # Blender的custom-normal短整数重新编码会有量化误差，允许方向差<0.03度。
        assert max(normal_errors) < 2.5e-7, (
            "原腿筒法线超出重新编码精度",
            max(normal_errors),
        )
        assert {name: snapshot(objects[name]) for name in protected} == protected, (
            "修改非腿部节点"
        )
    components = fix.position_components(legs)
    edge_counts = Counter()
    keys = [
        tuple(round(float(value), 5) for value in legs.matrix_world @ vertex.co)
        for vertex in legs.data.vertices
    ]
    for face in legs.data.polygons:
        for first, second in zip(
            face.vertices, list(face.vertices[1:]) + [face.vertices[0]]
        ):
            edge_counts[tuple(sorted((keys[first], keys[second])))] += 1
    non_manifold = sum(count != 2 for count in edge_counts.values())
    # 裤扣、侧袋在小高度带中形成方形外伸，裸髋profile不应保留该外伸。
    residue = [
        vertex.index
        for vertex in legs.data.vertices
        if 0.46 < (legs.matrix_world @ vertex.co).z < 0.67
        and (
            abs((legs.matrix_world @ vertex.co).x) > 0.305
            or abs((legs.matrix_world @ vertex.co).y) > 0.24
        )
    ]
    bare = len(components) == 3 and not residue and non_manifold == 0
    groups = []
    for faces in components:
        weights = {
            legs.vertex_groups[g.group].name
            for f in faces
            for i in legs.data.polygons[f].vertices
            for g in legs.data.vertices[i].groups
            if g.weight > 0.001
        }
        groups.append(
            (
                faces,
                next(
                    (side for side in ["l", "r"] if "lowerleg." + side in weights), None
                ),
            )
        )
    hip_faces = set().union(*(faces for faces, side in groups if side is None))
    leg_faces = {side: faces for faces, side in groups if side}
    cat = json.loads(options.catalog.read_text())
    body = next(
        x for x in cat["characters"] if x["character_key"] == "kaykit-medium-v1"
    )
    hashes = {}
    actions = arm.load_actions(bpy, body, hashes, options.assets, poses=arm.POSES)
    # 配对列表必须覆盖独立冻结参考的全部腰口，不能在新模型上只统计幸存点。
    pairs = []
    missing = []
    for coordinate, weights in expected_waist.items():
        point = Vector(coordinate)
        matches = []
        for obj in [legs, torso]:
            found = []
            for vertex in obj.data.vertices:
                actual = {
                    obj.vertex_groups[g.group].name: g.weight for g in vertex.groups
                }
                if (obj.matrix_world @ vertex.co - point).length < 2e-5 and all(
                    abs(weights.get(name, 0) - actual.get(name, 0)) < 2e-6
                    for name in weights.keys() | actual.keys()
                ):
                    found.append(vertex.index)
            matches.append(found)
        if all(matches):
            pairs.append((matches[0][0], matches[1]))
        else:
            missing.append(coordinate)
    records = []
    for motion, frame in arm.POSES:
        arm.apply_pose(bpy, rig, body, actions, motion, frame)
        hip_tree, points = surface(legs, hip_faces)
        _, top_points = surface(torso, set(range(len(torso.data.polygons))))
        gap = (
            max(
                (points[index] - top_points[matches[0]]).length
                for index, matches in pairs
            )
            if pairs
            else 999
        )
        intersections = {}
        volumes = {}
        for side, faces in leg_faces.items():
            tree, _ = surface(legs, faces)
            intersections[side] = len(hip_tree.overlap(tree))
            bone = "upperleg." + side
            transform = (
                rig.matrix_world
                @ rig.pose.bones[bone].matrix
                @ rig.data.bones[bone].matrix_local.inverted()
            )
            reference = transform @ Vector((0.138 if side == "l" else -0.138, 0, 0.515))
            hit, normal, _, _ = tree.find_nearest(reference)
            center = hit - normal * 0.005
            probes = [
                center + Vector(offset) * 0.001
                for offset in [
                    (0, 0, 0),
                    (1, 0, 0),
                    (-1, 0, 0),
                    (0, 1, 0),
                    (0, -1, 0),
                    (0, 0, 1),
                    (0, 0, -1),
                ]
            ]
            signed = [
                (point - surface.find_nearest(point)[0]).dot(
                    surface.find_nearest(point)[1]
                )
                for surface in [tree, hip_tree]
                for point in probes
            ]
            volumes[side] = {
                "probe_count": 7,
                "signed_distances": signed,
                "passed": all(distance < -1e-5 for distance in signed),
            }
        records.append(
            {
                "motion": motion,
                "frame": frame,
                "maximum_waist_gap": gap,
                "hip_leg_triangle_intersections": intersections,
                "hip_leg_overlap_volume": volumes,
                "passed": not missing
                and gap < 2e-5
                and len(intersections) == 2
                and all(x > 0 for x in intersections.values())
                and all(item["passed"] for item in volumes.values()),
            }
        )
    status = "passed" if bare and all(x["passed"] for x in records) else "failed"
    if options.export:
        arm.apply_pose(bpy, rig, body, actions, "rest", 0)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in [rig, *objects.values()]:
            obj.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=str(options.export),
            export_format="GLB",
            use_selection=True,
            export_animations=False,
            export_skins=True,
        )
    report = {
        "status": status,
        "input": str(options.input),
        "input_sha256": hashlib.sha256(options.input.read_bytes()).hexdigest(),
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "helper_sha256": hashlib.sha256(
            (R / "scripts/modular-character-human-waist-fit.py").read_bytes()
        ).hexdigest(),
        "animation_inputs": hashes,
        "baseline_input": str(options.baseline_input),
        "baseline_sha256": hashlib.sha256(
            options.baseline_input.read_bytes()
        ).hexdigest(),
        "expected_waist_vertices": len(expected_waist),
        "missing_waist_vertices": missing,
        "settings": settings,
        "apply_fix": options.apply_fix,
        "production_evidence": evidence,
        "component_count": len(components),
        "non_manifold_position_edges": non_manifold,
        "garment_residue_vertices": residue,
        "waist_interface_pairs": len(pairs),
        "protected_leg_vertices": len(keep) if options.apply_fix else None,
        "maximum_preserved_leg_normal_direction_error": max(normal_errors) ** 0.5
        if options.apply_fix
        else None,
        "preserved_non_leg_nodes": list(protected) if options.apply_fix else None,
        "records": records,
        "output": {
            "path": str(options.export),
            "sha256": hashlib.sha256(options.export.read_bytes()).hexdigest(),
        }
        if options.export
        else None,
        "limits": [
            "Volume probes prove local hip/leg contact for eight samples, not continuous animation or garment fit.",
            "Lower wearables require independent closed-surface and visible-fit checks using this new bare-body reference.",
            "Protected existing mesh checks run only during trial --apply-fix; final-read verifies actual artifact geometry and interfaces without fitting.",
        ],
    }
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    assert status == "passed", "人体裤形残留或接口失败，详见 " + str(options.report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--baseline-input", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--export", type=Path)
    parser.add_argument("--apply-fix", action="store_true")
    run(
        parser.parse_args(
            sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
        )
    )
