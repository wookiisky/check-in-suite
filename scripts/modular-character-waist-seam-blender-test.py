"""从实际 GLB 扫描上装和下装的腰线，并验证保留款的腰口搭接。"""

import argparse
from collections import defaultdict
import importlib.util
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


ROOT = Path(__file__).resolve().parents[1]
SHORTS = "skeleton-minion-lower-v1"
REFERENCE = "upper-rogue-v1"
DIRECTIONS = 72
SEAM_BAND = (0.715, 0.720, 0.724)
MAGE_OVERLAP = (0.720, 0.724)
OVERLAP_SECTIONS = {
    "kaykit-legacy-skeleton-warrior-upper": SEAM_BAND,
    "kaykit-legacy-skeleton-mage-lower": SEAM_BAND,
    "lower-rogue-v1": SEAM_BAND,
    "kaykit-adventurers-mage-upper": MAGE_OVERLAP,
    "kaykit-adventurers-mage-lower": MAGE_OVERLAP,
    "kaykit-skeletons-mage-upper": MAGE_OVERLAP,
    "kaykit-skeletons-mage-lower": MAGE_OVERLAP,
}
REFERENCE_HEIGHT = 0.725
SCAN_HEIGHTS = (0.58, 0.59, 0.60, 0.62, 0.64, 0.66, 0.68, 0.70, 0.71,
                *SEAM_BAND, REFERENCE_HEIGHT, 0.73, 0.74, 0.75, 0.76, 0.78)
# 毛边短裤等现有皮带在同一高度约有 0.05 的外凸余量，银扣只占局部角度。
WAIST_ALLOWANCE = 0.05


# 使用目录声明的节点和已导出的三角面，读入同一 GLB 的衣物共用场景。
def scan(assets, wearables):
    spec = importlib.util.spec_from_file_location(
        "waist_seam_assets", ROOT / "scripts/verify-modular-character-appearance.py"
    )
    appearance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(appearance)
    by_model = defaultdict(list)
    for item in wearables:
        by_model[item["model_asset_key"]].append(item)
    directions = [Vector((math.sin(angle), math.cos(angle), 0))
                  for angle in (step * math.tau / DIRECTIONS for step in range(DIRECTIONS))]
    result = {}
    for key, items in by_model.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        path = appearance.asset_path(key, assets)
        bpy.ops.import_scene.gltf(filepath=str(path))
        for item in items:
            surface = garment_surface(item["nodes"])
            sections = [scan_section(surface, directions, height) for height in SCAN_HEIGHTS]
            result[item["wearable_key"]] = {
                "name": item["name"],
                "slot": item["slot"],
                "model_asset_key": key,
                "sections": sections,
            }
    return result


# 衣片在共同的角色坐标系中建树。只有护腕的上装会自然表现为腰部无覆盖。
def garment_surface(nodes):
    points, triangles = [], []
    for name in nodes:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            raise ValueError(f"找不到衣物网格 {name}")
        offset = len(points)
        points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        obj.data.calc_loop_triangles()
        triangles.extend(tuple(offset + index for index in triangle.vertices)
                         for triangle in obj.data.loop_triangles)
    return BVHTree.FromPolygons(points, triangles, all_triangles=True) if triangles else None


# 射线从圆周指向骨架中心，最近命中给出该角度可见衣片的外轮廓。
def scan_section(surface, directions, height):
    center = Vector((0, 0, height))
    radii = []
    for direction in directions:
        hit = surface.ray_cast(center + direction, -direction, 1)[0] if surface else None
        radii.append(round((hit - center).xy.length, 6) if hit is not None else None)
    return {"height": height, "covered": sum(radius is not None for radius in radii), "radii": radii}


# 短裤的主腰面应跨过接合线，并与默认盗贼上装的实测轮廓接近。
def check_shorts(result):
    reference = next(section for section in result[REFERENCE]["sections"]
                     if section["height"] == REFERENCE_HEIGHT)
    sections = [section for section in result[SHORTS]["sections"] if section["height"] in SEAM_BAND]
    failures = []
    if reference["covered"] != DIRECTIONS:
        failures.append(f"{REFERENCE} z={REFERENCE_HEIGHT:.3f} 缺少完整参考轮廓")
    for section in sections:
        height, covered = section["height"], section["covered"]
        if covered != DIRECTIONS:
            failures.append(f"{SHORTS} z={height:.3f} 腰口仅覆盖 {covered}/{DIRECTIONS} 个方向")
            continue
        if reference["covered"] != DIRECTIONS:
            continue
        excesses = sorted(radius - baseline for radius, baseline
                          in zip(section["radii"], reference["radii"]))
        excess = excesses[math.ceil(len(excesses) * 0.9) - 1]
        section["radial_excess_p90"] = round(excess, 6)
        if excess > WAIST_ALLOWANCE:
            failures.append(f"{SHORTS} z={height:.3f} 主腰面突出 {excess:.3f}，上限 {WAIST_ALLOWANCE:.3f}")
    return failures


# 红紫上下装覆盖同一段腰线，保留的其他部件继续跨过各自原来的空档。
def check_waist_overlap(result):
    failures = []
    for key, heights in OVERLAP_SECTIONS.items():
        for section in result[key]["sections"]:
            if section["height"] in heights and section["covered"] != DIRECTIONS:
                failures.append(f"{key} z={section['height']:.3f} 腰部仅覆盖 {section['covered']}/{DIRECTIONS} 个方向")
    return failures


# 始终先输出扫描，再让 Blender 以非零状态返回回归失败。
def main(options):
    base = options.candidate or ROOT
    catalog = options.catalog or base / "internal/character/character-catalog.json"
    assets = options.assets or base / "internal/assets/builtin"
    wearables = [item for item in json.loads(catalog.read_text())["wearables"]
                 if item["slot"] in ("upper", "lower")]
    result = scan(assets, wearables)
    failures = check_shorts(result) + check_waist_overlap(result)
    for key, item in result.items():
        counts = " ".join(f"{section['height']:.3f}:{section['covered']}"
                          for section in item["sections"] if section["covered"])
        print("衣物腰线扫描", key, counts or "腰线采样无命中", flush=True)
    if options.report:
        report = {
            "catalog": str(catalog),
            "assets": str(assets),
            "directions": DIRECTIONS,
            "wearables": result,
            "failures": failures,
            "limits": "绑定姿势的有限水平截面，不判断原款开口或动画穿插。",
        }
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for failure in failures:
        print("衣物腰线回归失败", failure, flush=True)
    return int(bool(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--report", type=Path)
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    raise SystemExit(main(parser.parse_args(args)))
