"""在实际GLB与动作上复现/验收人工股骨上环连接，最终读取模式不再修形。"""

from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import closest_point_on_tri

R = Path(__file__).resolve().parents[1]


# 模型、动作和工具都记录实际读取的字节。
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, R / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 保留原面、全部属性及骨架；允许变化域仅为人工上环权重。
def attributes(obj):
    return {
        "points": [tuple(v.co) for v in obj.data.vertices],
        "faces": [tuple(p.vertices) for p in obj.data.polygons],
        "weights": [
            {obj.vertex_groups[g.group].name: g.weight for g in v.groups}
            for v in obj.data.vertices
        ],
        "uv": [[tuple(v.uv) for v in layer.data] for layer in obj.data.uv_layers],
        "normals": [tuple(n.vector) for n in obj.data.corner_normals],
        "materials": [m.name for m in obj.data.materials],
        "face_materials": [p.material_index for p in obj.data.polygons],
    }


# 独立于制作helper，按真实材质/蒙皮分离球与股骨；支持最终GLB混合绑定。
def joints(obj, components):
    hips = {}
    thighs = {}
    for part in components.mesh_components(obj):
        if part["materials"] != ["Skeleton_Bone"]:
            continue
        bones = {
            obj.vertex_groups[g.group].name
            for i in part["vertices"]
            for g in obj.data.vertices[i].groups
            if g.weight > 1e-5
        }
        side = "l" if part["center"].x > 0 else "r"
        if bones == {"hips"}:
            hips[side] = part
        if "upperleg." + side in bones and bones <= {"hips", "upperleg." + side}:
            thighs[side] = part
    assert len(hips) == len(thighs) == 2, "人工球/股骨组件不唯一"
    return hips, thighs


# 两线段的最近点包含内部解与四个端点边界，不用顶点采样冒充精确间距。
def segment_distance(a, b, c, d):
    u = b - a
    v = d - c
    w = a - c
    aa = u.dot(u)
    bb = u.dot(v)
    cc = v.dot(v)
    dd = u.dot(w)
    ee = v.dot(w)
    den = aa * cc - bb * bb
    values = []
    if den > 1e-18:
        s = (bb * ee - cc * dd) / den
        t = (aa * ee - bb * dd) / den
        if 0 <= s <= 1 and 0 <= t <= 1:
            values.append((w + s * u - t * v).length)
    for p, q0, q1 in [(a, c, d), (b, c, d), (c, a, b), (d, a, b)]:
        axis = q1 - q0
        amount = (
            max(0, min(1, (p - q0).dot(axis) / axis.length_squared))
            if axis.length_squared
            else 0
        )
        values.append((p - (q0 + axis * amount)).length)
    return min(values)


# 对不相交的三角曲面，最短距离发生于点到面或边到边。
def exact_gap(points, first, second):
    result = float("inf")
    for tri_a in first:
        a = [points[i] for i in tri_a]
        for tri_b in second:
            b = [points[i] for i in tri_b]
            for p in a:
                result = min(result, (p - closest_point_on_tri(p, *b)).length)
            for p in b:
                result = min(result, (p - closest_point_on_tri(p, *a)).length)
            for i in range(3):
                for j in range(3):
                    result = min(
                        result,
                        segment_distance(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3]),
                    )
    return result


# 只在显式试修模式调用生产helper；最终验收从真实交付字节求值。
def main(options):
    comp = load("hip_test_components", "modular-character-clothing-fit.py")
    arm = load("hip_test_arms", "verify-modular-character-arms.py")
    geo = load("hip_test_geometry", "modular-character-torso-back-fit-blender-test.py")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(options.input))
    rig = next(x for x in bpy.data.objects if x.type == "ARMATURE")
    rig.animation_data_clear()
    legs = bpy.data.objects["body_legs"]
    objects = [x for x in bpy.data.objects if x.type == "MESH"]
    before = attributes(legs)
    protected = {x.name: attributes(x) for x in objects if x != legs}
    bones = {b.name: [list(row) for row in b.matrix_local] for b in rig.data.bones}
    hips, thighs = joints(legs, comp)
    rings = {}
    for side, part in thighs.items():
        height = part["bounds"][2][1]
        indices = [
            i
            for i in part["vertices"]
            if abs((legs.matrix_world @ legs.data.vertices[i].co).z - height) < 1e-5
        ]
        rings[side] = indices
    settings = json.loads(options.settings.read_text())
    operation = None
    if options.apply_fix:
        fix = load("hip_test_fix", "modular-character-skeleton-hip.py")
        operation = fix.bind_skeleton_hip_joints(legs, rig, settings)
        after = attributes(legs)
        allowed = {i for indices in rings.values() for i in indices}
        assert {k: v for k, v in before.items() if k != "weights"} == {
            k: v for k, v in after.items() if k != "weights"
        }, "修改了REST几何/面/UV/法线/材质"
        assert all(
            before["weights"][i] == after["weights"][i]
            for i in range(len(legs.data.vertices))
            if i not in allowed
        ), "修改了上环之外原权重"
        assert all(
            after["weights"][i] == {settings["upper_ring_bone"]: 1.0} for i in allowed
        ), "人工上环未绑定hips"
        assert protected == {x.name: attributes(x) for x in objects if x != legs}, (
            "修改了其他节点"
        )
        assert bones == {
            b.name: [list(row) for row in b.matrix_local] for b in rig.data.bones
        }, "修改了骨架"
    cat = json.loads(options.catalog.read_text())
    body = next(
        x for x in cat["characters"] if x["character_key"] == "kaykit-skeleton-v1"
    )
    hashes = {}
    actions = arm.load_actions(bpy, body, hashes, options.assets, poses=arm.POSES)
    records = []
    cache = {}
    legs.data.calc_loop_triangles()
    triangles = {}
    for side in ["l", "r"]:
        triangles[side] = [
            [
                tuple(t.vertices)
                for t in legs.data.loop_triangles
                if t.polygon_index in set(part["faces"])
            ]
            for part in [hips[side], thighs[side]]
        ]
    for motion, frame in arm.POSES:
        arm.apply_pose(bpy, rig, body, actions, motion, frame)
        points, _ = geo.evaluated_geometry(legs)
        for side in ["l", "r"]:
            htri, ttri = triangles[side]
            htree = BVHTree.FromPolygons(points, htri, all_triangles=True)
            ttree = BVHTree.FromPolygons(points, ttri, all_triangles=True)
            crossings = htree.overlap(ttree)
            top = set(rings[side])
            unique = {
                tuple(
                    round(float(v), 7)
                    for v in legs.matrix_world @ legs.data.vertices[i].co
                ): points[i]
                for i in top
            }
            center = sum(unique.values(), Vector()) / len(unique)
            cap = next(tri for tri in ttri if all(i in top for i in tri))
            a, b, c = [points[i] for i in cap]
            normal = (b - a).cross(c - a).normalized()
            probe_center = center - normal * 0.004
            probes = [
                probe_center + Vector(offset) * 0.001
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
                (p - tree.find_nearest(p)[0]).dot(tree.find_nearest(p)[1])
                for tree in [htree, ttree]
                for p in probes
            ]
            key = hashlib.sha256(
                repr(
                    [
                        [tuple(points[i]) for tri in ts for i in tri]
                        for ts in [htri, ttri]
                    ]
                ).encode()
            ).hexdigest()
            if key not in cache:
                cache[key] = 0.0 if crossings else exact_gap(points, htri, ttri)
            records.append(
                {
                    "motion": motion,
                    "frame": frame,
                    "side": side,
                    "actual_triangle_crossings": len(crossings),
                    "exact_triangle_surface_gap": cache[key],
                    "upper_ring_center": list(center),
                    "upperleg_bone_head": list(
                        rig.matrix_world @ rig.pose.bones["upperleg." + side].head
                    ),
                    "hip_center": list(
                        sum((points[i] for i in hips[side]["vertices"]), Vector())
                        / len(hips[side]["vertices"])
                    ),
                    "probe_count": 7,
                    "signed_distances": signed,
                    "passed": bool(crossings) and all(d < -1e-5 for d in signed),
                }
            )
    if options.export:
        arm.apply_pose(bpy, rig, body, actions, "rest", 0)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in [rig, *objects]:
            obj.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=str(options.export),
            export_format="GLB",
            use_selection=True,
            export_animations=False,
            export_skins=True,
        )
    report = {
        "status": "passed" if all(x["passed"] for x in records) else "failed",
        "input": {
            "path": str(options.input),
            "sha256": hashlib.sha256(options.input.read_bytes()).hexdigest(),
        },
        "apply_fix": options.apply_fix,
        "settings": settings,
        "operation": operation,
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "animation_inputs": hashes,
        "ring_counts": {
            side: {
                "unique_positions": len(
                    {
                        tuple(
                            round(float(v), 5)
                            for v in legs.matrix_world @ legs.data.vertices[i].co
                        )
                        for i in indices
                    }
                ),
                "actual_vertices": len(indices),
                "affected_loops": sum(
                    loop.vertex_index in indices for loop in legs.data.loops
                ),
            }
            for side, indices in rings.items()
        },
        "protected_source_triangles": sum(
            legs.data.materials[p.material_index].name.split(".")[0] != "Skeleton_Bone"
            for p in legs.data.polygons
        ),
        "protected_hip_triangles": sum(len(p["faces"]) for p in hips.values()),
        "source_protection_assertions_executed": options.apply_fix,
        "records": records,
        "output": {
            "path": str(options.export),
            "sha256": hashlib.sha256(options.export.read_bytes()).hexdigest(),
        }
        if options.export
        else None,
        "limits": [
            "Eight actual poses and local seven-probe overlap only, not continuous animation.",
            "Existing source protection is asserted during --apply-fix; final-read does not fit. Cross-export source protection is independently audited.",
        ],
    }
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(report["status"], report["ring_counts"], flush=True)
    assert report["status"] == "passed", "实际髋球—股骨接口断开，详见 " + str(
        options.report
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--export", type=Path)
    parser.add_argument("--apply-fix", action="store_true")
    main(parser.parse_args(sys.argv[sys.argv.index("--") + 1 :]))
