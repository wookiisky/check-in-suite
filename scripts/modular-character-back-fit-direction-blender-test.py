"""在真实骨架与来源披肩上验证有符号偏移，保护原正向结果。"""

from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import sys

import bpy
from mathutils import Vector


# 独立加载当前helper和冻结的R6原producer，避免用新算法生成旧期望。
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 属性直接取真实Blender网格，不将UV/蒙皮保护简化为计数比较。
def attributes(obj):
    return {
        "points": [tuple(v.co) for v in obj.data.vertices],
        "faces": [tuple(p.vertices) for p in obj.data.polygons],
        "uv": [[tuple(v.uv) for v in layer.data] for layer in obj.data.uv_layers],
        "weights": [
            {obj.vertex_groups[g.group].name: g.weight for g in v.groups}
            for v in obj.data.vertices
        ],
        "materials": [p.material_index for p in obj.data.polygons],
        "normals": [tuple(n.vector) for n in obj.data.corner_normals],
    }


# 测试点以真实R6胸骨/肩骨建立局部轴，前、后、远端各有独立完整四边面。
def fixture(rig):
    bone = rig.data.bones["chest"]
    anchor = rig.matrix_world @ bone.tail_local
    vertical = (
        rig.matrix_world.to_3x3() @ (bone.tail_local - bone.head_local)
    ).normalized()
    lateral = (
        rig.matrix_world.to_3x3()
        @ (
            rig.data.bones["upperarm.l"].head_local
            - rig.data.bones["upperarm.r"].head_local
        )
    ).normalized()
    posterior = vertical.cross(lateral).normalized()
    lateral = posterior.cross(vertical).normalized()
    points = []
    for x, y in [(0, -0.20), (0, 0.20), (0.5, -0.20)]:
        points.extend(
            anchor + lateral * (x + dx) + posterior * y + vertical * dz
            for dx, dz in [
                (-0.005, -0.005),
                (0.005, -0.005),
                (0.005, 0.005),
                (-0.005, 0.005),
            ]
        )
    mesh = bpy.data.meshes.new("有方向偏移测试网格")
    mesh.from_pydata(points, [], [tuple(range(i, i + 4)) for i in [0, 4, 8]])
    mesh.uv_layers.new()
    for index, loop in enumerate(mesh.uv_layers.active.data):
        loop.uv = ((index % 4) / 4, index / 12)
    obj = bpy.data.objects.new("前后与远端测试", mesh)
    bpy.context.collection.objects.link(obj)
    obj.vertex_groups.new(name="chest").add(list(range(12)), 0.6, "REPLACE")
    obj.vertex_groups.new(name="hips").add(list(range(12)), 0.4, "REPLACE")
    obj.modifiers.new("真实骨架", "ARMATURE").object = rig
    return obj, posterior


# 所有试件只存在于独立Blender进程，不导出或写回生产GLB。
def main(options):
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    current = load(options.helper, "direction_current")
    old = load(options.baseline_helper, "direction_r6_producer")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(options.rig_input))
    rig = next(obj for obj in bpy.data.objects if obj.type == "ARMATURE")
    rig.animation_data_clear()
    settings = {
        "anchor_bone": "chest",
        "radius_x": 0.3,
        "radius_z": 0.2,
        "posterior_start": 0.0,
        "posterior_full": -0.15,
        "offset": -0.02,
    }
    obj, posterior = fixture(rig)
    before = attributes(obj)
    result = current.fit_back_neck(obj, rig, settings)
    after = attributes(obj)
    front_displacements = [
        (obj.data.vertices[i].co - Vector(before["points"][i])).dot(posterior)
        for i in range(4)
    ]
    frozen_attributes = ["faces", "uv", "weights", "materials"]
    negative = {
        "case": "negative_offset_front_gate",
        "front_signed_displacements": front_displacements,
        "rear_and_distant_unchanged": before["points"][4:] == after["points"][4:],
        "protected_attributes_unchanged": all(
            before[k] == after[k] for k in frozen_attributes
        ),
        "result": result,
    }
    negative["passed"] = (
        all(-0.02001 < amount < -0.0199 for amount in front_displacements)
        and negative["rear_and_distant_unchanged"]
        and negative["protected_attributes_unchanged"]
        and 0.0199 < result["maximum_displacement"] <= 0.02001
    )
    records = [negative]
    for amount in [0.0, -1e-8, 1e-8]:
        obj, _ = fixture(rig)
        before = attributes(obj)
        result = current.fit_back_neck(obj, rig, {**settings, "offset": amount})
        records.append(
            {
                "case": "epsilon_noop",
                "offset": amount,
                "passed": attributes(obj) == before and not result["moved_vertices"],
            }
        )
    recipe = json.loads(options.recipe.read_text())
    source_inputs = []
    for key in ["kaykit-skeletons-minion", "kaykit-skeletons-warrior"]:
        source = next(s for s in recipe["sources"] if s["key"] == key)
        path = Path(source["normalized_model"])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
        rig = next(obj for obj in bpy.data.objects if obj.type == "ARMATURE")
        rig.animation_data_clear()
        original = bpy.data.objects["upper_provider"]
        duplicate = original.copy()
        duplicate.data = original.data.copy()
        bpy.context.collection.objects.link(duplicate)
        before = attributes(original)
        positive_settings = recipe["back_clothing_fit"][key + "-back-cloak"]
        old_result = old.fit_back_neck(original, rig, positive_settings)
        new_result = current.fit_back_neck(duplicate, rig, positive_settings)
        after = attributes(duplicate)
        source_inputs.append({"path": str(path.resolve()), "sha256": sha(path)})
        records.append(
            {
                "case": "positive_actual_source_equivalence",
                "source": key,
                "moved_vertices": len(new_result["moved_vertices"]),
                "maximum_displacement": new_result["maximum_displacement"],
                "passed": attributes(original) == after
                and old_result == new_result
                and bool(new_result["moved_vertices"])
                and all(before[k] == after[k] for k in frozen_attributes),
            }
        )
    report = {
        "status": "passed" if all(r["passed"] for r in records) else "failed",
        "records": records,
        "actual_source_inputs": source_inputs,
        "inputs": [
            {"path": str(path.resolve()), "sha256": sha(path)}
            for path in [
                options.helper,
                options.baseline_helper,
                options.rig_input,
                options.recipe,
                Path(__file__),
            ]
        ],
        "limits": [
            "This tests signed field behavior and positive-source equivalence; it does not fit or accept a LegacyMage cloak repair.",
            "No production GLB was changed or exported.",
        ],
    }
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(report["status"], [(r["case"], r["passed"]) for r in records], flush=True)
    assert report["status"] == "passed", "有方向偏移验证失败，详见实际报告"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ["helper", "baseline-helper", "rig-input", "recipe", "report"]:
        parser.add_argument("--" + name, type=Path, required=True)
    main(parser.parse_args(sys.argv[sys.argv.index("--") + 1 :]))
