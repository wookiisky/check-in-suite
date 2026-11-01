"""将官方人物动作离线映射到统一身体骨架，源网格不进入动作产物。"""

import argparse
import base64
import bisect
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / ".local/3d-sources/provider-packs"
BUILTIN = ROOT / "internal/assets/builtin"
MANIFEST = ROOT / "internal/assets/provider-animation-manifest.json"
CANONICAL_BONES = ("root", "hips", "spine", "chest", "head", *(
    name + "." + side for side in ("l", "r")
    for name in ("upperarm", "lowerarm", "wrist", "hand", "handslot", "upperleg", "lowerleg", "foot", "toes")
))


# 读取真实 GLB/GLTF；未内嵌的源数据只在本地制作时解析。
def read_document(path):
    data = path.read_bytes()
    if data[:4] == b"glTF":
        size = struct.unpack_from("<I", data, 12)[0]
        doc = json.loads(data[20:20 + size])
        offset = 20 + size
        blob = data[offset + 8:] if offset < len(data) else b""
    else:
        doc = json.loads(data)
        buffers = []
        for item in doc.get("buffers", []):
            uri = item["uri"]
            buffers.append(base64.b64decode(uri.split(",", 1)[1]) if uri.startswith("data:") else (path.parent / uri).read_bytes())
        blob = buffers
    return doc, blob


# 按 glTF 实际 stride/componentType 解码，避免把 bufferView 字节当成连续 float。
def read_accessor(doc, blob, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    binary = blob[view.get("buffer", 0)] if isinstance(blob, list) else blob
    count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[accessor["type"]]
    kind = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}[accessor["componentType"]]
    stride = view.get("byteStride", struct.calcsize("<" + kind) * count)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [struct.unpack_from("<" + kind * count, binary, offset + item * stride) for item in range(accessor["count"])]


# 标准节点仅保留关节及其祖先，原人物和 IK 辅助几何不随动作交付。
def skeleton_nodes(doc):
    parents = {child: index for index, node in enumerate(doc["nodes"]) for child in node.get("children", [])}
    chosen = {index for index, node in enumerate(doc["nodes"]) if node.get("name") in CANONICAL_BONES}
    for index in list(chosen):
        while index in parents:
            index = parents[index]
            chosen.add(index)
    order = sorted(chosen)
    remap = {old: new for new, old in enumerate(order)}
    nodes = []
    for old in order:
        source = doc["nodes"][old]
        node = {key: source[key] for key in ("name", "translation", "rotation", "scale", "matrix") if key in source}
        children = [remap[child] for child in source.get("children", []) if child in chosen]
        if children:
            node["children"] = children
        nodes.append(node)
    roots = [remap[index] for index in order if parents.get(index) not in chosen]
    return nodes, roots


# glTF 使用列主序矩阵，mathutils 构造器接收行。
def node_matrix(node):
    from mathutils import Matrix, Quaternion, Vector
    if "matrix" in node:
        return Matrix([node["matrix"][offset:offset + 4] for offset in range(0, 16, 4)]).transposed()
    q = node.get("rotation", (0, 0, 0, 1))
    return Matrix.LocRotScale(Vector(node.get("translation", (0, 0, 0))), Quaternion((q[3], *q[:3])), Vector(node.get("scale", (1, 1, 1))))


# 层级求值保留源的真实父节点，不假定所有人物都使用同一种骨架。
def world_matrices(doc, local=None):
    parents = {child: index for index, node in enumerate(doc["nodes"]) for child in node.get("children", [])}
    result = {}

    def visit(index):
        if index not in result:
            matrix = local[index] if local is not None else node_matrix(doc["nodes"][index])
            result[index] = visit(parents[index]) @ matrix if index in parents else matrix
        return result[index]

    for index in range(len(doc["nodes"])):
        visit(index)
    return result


# inverseBindMatrices 记录真实绑定姿势；节点默认姿势可能是导出时的动作首帧。
def bind_matrices(doc, blob):
    from mathutils import Matrix
    world = world_matrices(doc)
    for skin_index, skin in enumerate(doc.get("skins", [])):
        if "inverseBindMatrices" not in skin:
            continue
        mesh_index = next((index for index, node in enumerate(doc["nodes"]) if node.get("skin") == skin_index), None)
        mesh_world = world[mesh_index] if mesh_index is not None else Matrix.Identity(4)
        for node, values in zip(skin["joints"], read_accessor(doc, blob, skin["inverseBindMatrices"])):
            inverse = Matrix([values[offset:offset + 4] for offset in range(0, 16, 4)]).transposed()
            world[node] = mesh_world @ inverse.inverted()
    return world


# 具体来源的关节语义集中映射；未知非人形不会冒充已重定向的人物动作。
def bone_mapping(doc):
    names = {node.get("name"): index for index, node in enumerate(doc["nodes"])}
    if "hips" in names and "upperleg.l" in names:
        return {name: names[name] for name in CANONICAL_BONES if name in names}, "kaykit-humanoid"
    if "Body" in names and "armLeft" in names:
        aliases = {"hips": "Body", "head": "Head", "upperarm.l": "armLeft", "upperarm.r": "armRight", "handslot.l": "handSlotLeft", "handslot.r": "handSlotRight"}
        return {target: names[source] for target, source in aliases.items() if source in names}, "kaykit-legacy-six-parts"
    if "torso" in names and "arm-left" in names:
        aliases = {"root": "root", "hips": "torso", "head": "head", "upperarm.l": "arm-left", "upperarm.r": "arm-right", "upperleg.l": "leg-left", "upperleg.r": "leg-right"}
        return {target: names[source] for target, source in aliases.items() if source in names}, "kenney-six-parts"
    aliases = {"root": "root", "hips": "body", "head": "head", "upperarm.l": "arm-left", "upperarm.r": "arm-right", "upperleg.l": "leg-left", "upperleg.r": "leg-right"}
    if "body" in names and "arm-left" in names:
        return {target: names[source] for target, source in aliases.items() if source in names}, "kenney-mini-humanoid"
    return {}, "unsupported-source-rig"


# 采样保留源的线性、阶梯与三次插值；四元数用最短弧球面插值。
def sample_track(times, values, interpolation, time, rotation=False):
    from mathutils import Quaternion
    index = max(0, min(len(times) - 2, bisect.bisect_right(times, time) - 1))
    if len(times) == 1:
        return values[1] if interpolation == "CUBICSPLINE" else values[0]
    span = times[index + 1] - times[index]
    amount = max(0, min(1, (time - times[index]) / span)) if span > 0 else 0
    if interpolation == "STEP":
        return values[index + (amount == 1)]
    if interpolation == "CUBICSPLINE":
        a, tangent_a = values[index * 3 + 1:index * 3 + 3]
        tangent_b, b = values[(index + 1) * 3:(index + 1) * 3 + 2]
        t = amount
        result = [(2*t**3-3*t*t+1)*x + (t**3-2*t*t+t)*span*ta + (-2*t**3+3*t*t)*y + (t**3-t*t)*span*tb for x, y, ta, tb in zip(a, b, tangent_a, tangent_b)]
        if rotation:
            q = Quaternion((result[3], *result[:3])).normalized()
            return (q.x, q.y, q.z, q.w)
        return result
    a, b = values[index:index + 2]
    if rotation:
        q = Quaternion((a[3], *a[:3])).slerp(Quaternion((b[3], *b[:3])), amount)
        return (q.x, q.y, q.z, q.w)
    return [x + (y-x)*amount for x, y in zip(a, b)]


# 全局绑定旋转差烘焙到目标，目标节点、绑定姿势与肢段长度保持标准身体。
def retarget(doc, blob, clip, canonical, canonical_blob):
    from mathutils import Matrix, Quaternion, Vector
    mapping, profile = bone_mapping(doc)
    if not mapping:
        raise ValueError("没有已核对的人形关节映射")
    source_rest = bind_matrices(doc, blob)
    target_rest = bind_matrices(canonical, canonical_blob)
    target_names = {node.get("name"): index for index, node in enumerate(canonical["nodes"])}
    target_parents = {child: index for index, node in enumerate(canonical["nodes"]) for child in node.get("children", [])}
    ordered = sorted(CANONICAL_BONES, key=lambda name: depth(target_names[name], target_parents))
    source_defaults = [node_matrix(node).decompose() for node in doc["nodes"]]
    tracks = []
    duration = 0
    for channel in clip["channels"]:
        target = channel["target"]
        if target.get("path") not in {"translation", "rotation", "scale"}:
            continue
        sampler = clip["samplers"][channel["sampler"]]
        times = [item[0] for item in read_accessor(doc, blob, sampler["input"])]
        values = read_accessor(doc, blob, sampler["output"])
        duration = max(duration, times[-1])
        tracks.append((target["node"], target["path"], times, values, sampler.get("interpolation", "LINEAR")))
    duration = max(duration, 1/30)
    times = [index / 30 for index in range(math.floor(duration * 30) + 1)]
    if duration - times[-1] > 1e-6:
        times.append(duration)
    if len(times) < 2:
        times.append(duration)
    source_height = max((source_rest[index].translation.y for index in mapping.values()), default=1)
    target_height = max(target_rest[target_names[name]].translation.y for name in mapping)
    ratio = target_height / source_height if abs(source_height) > 1e-5 else 1
    output = {name: {"translation": [], "rotation": [], "scale": []} for name in CANONICAL_BONES}
    for time in times:
        states = [[part.copy() for part in values] for values in source_defaults]
        for index, path, keys, values, interpolation in tracks:
            value = sample_track(keys, values, interpolation, time, path == "rotation")
            states[index][{"translation": 0, "rotation": 1, "scale": 2}[path]] = Quaternion((value[3], *value[:3])) if path == "rotation" else Vector(value)
        source_world = world_matrices(doc, [Matrix.LocRotScale(*values) for values in states])
        target_world = {}
        for name in ordered:
            index = target_names[name]
            parent = target_parents.get(index)
            parent_world = target_world.get(parent, target_rest.get(parent, Matrix.Identity(4)))
            rest = target_rest[index]
            local_rest = target_rest[parent].inverted() @ rest if parent in target_rest else rest
            inherited = parent_world @ local_rest
            rotation = inherited.to_quaternion()
            position = inherited.translation
            if name in mapping:
                source_index = mapping[name]
                delta = source_world[source_index].to_quaternion() @ source_rest[source_index].to_quaternion().inverted()
                rotation = delta @ rest.to_quaternion()
                if name in {"root", "hips"}:
                    position = rest.translation + (source_world[source_index].translation - source_rest[source_index].translation) * ratio
            pose = Matrix.LocRotScale(position, rotation, rest.to_scale())
            target_world[index] = pose
            local = parent_world.inverted() @ pose
            location, quaternion, scale = local.decompose()
            if output[name]["rotation"]:
                previous = output[name]["rotation"][-1]
                if quaternion.w*previous[3] + sum(quaternion[axis]*previous[axis] for axis in range(3)) < 0:
                    quaternion.negate()
            output[name]["translation"].append(tuple(round(x, 6) for x in location))
            output[name]["rotation"].append(tuple(round(x, 6) for x in (quaternion.x, quaternion.y, quaternion.z, quaternion.w)))
            output[name]["scale"].append(tuple(round(x, 6) for x in scale))
    return times, output, {"profile": profile, "method": "global-bind-rotation-delta-with-canonical-segment-lengths", "translation_scale": ratio, "fps": 30, "mapped_bones": {name: doc["nodes"][index]["name"] for name, index in mapping.items()}}


# 父节点数量决定处理顺序，保证子骨使用本帧刚更新的父姿势。
def depth(index, parents):
    count = 0
    while index in parents:
        index = parents[index]
        count += 1
    return count


# 每个动作独立一个小型GLB，运行时只加载当前选择的片段。
def write_clip(path, name, nodes, roots, times, poses):
    binary = bytearray()
    views, accessors = [], []

    def append(values, kind):
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        for row in values:
            binary.extend(struct.pack("<" + "f" * len(row), *row))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset})
        accessor = {"bufferView": len(views)-1, "componentType": 5126, "count": len(values), "type": kind}
        if kind == "SCALAR":
            accessor.update(min=[values[0][0]], max=[values[-1][0]])
        accessors.append(accessor)
        return len(accessors)-1

    timeline = append([(time,) for time in times], "SCALAR")
    samplers, channels = [], []
    indices = {node["name"]: index for index, node in enumerate(nodes)}
    for bone, tracks in poses.items():
        for kind, values in tracks.items():
            output = append(values, "VEC4" if kind == "rotation" else "VEC3")
            samplers.append({"input": timeline, "output": output, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers)-1, "target": {"node": indices[bone], "path": kind}})
    doc = {"asset": {"version": "2.0", "generator": "check-in-suite canonical animation importer"}, "scene": 0, "scenes": [{"nodes": roots}], "nodes": nodes, "animations": [{"name": name, "samplers": samplers, "channels": channels}], "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors}
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    result = struct.pack("<4sII", b"glTF", 2, 12+8+len(encoded)+8+len(binary)) + struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    if path.exists() and path.read_bytes() != result:
        raise ValueError("动作资源身份已存在且字节不同: " + path.name)
    path.write_bytes(result)


# 逐源片段统计保留重复来源，导出只交付不同的实际动作曲线。
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--first-medium", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    canonical, canonical_blob = read_document(BUILTIN / "character-medium-v1.glb")
    nodes, roots = skeleton_nodes(canonical)
    manifest = {
        "body_key": "kaykit-medium-body-v1", "rig_key": "kaykit-adventurers-medium-v1",
        "complete": False,
        "completed_scope": "medium-general-first-batch" if args.first_medium else "supported-gltf-humanoid-clips",
        "remaining_scope": ["other-medium-animation-sets", "large-rig-retargeting", "other-character-source-clips", "fbx-only-character-clips"],
        "checkpoint": {
            "command": "/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/import-provider-animations.py -- --first-medium",
            "note": "此命令仅复现已完成的Medium General批次；其他来源尚未开始，不能视为全量动作接入完成。",
        },
        "sources": [], "assets": [], "animations": [],
    }
    unique = {}
    paths = sorted(PACKS.rglob("*.glb"), key=lambda path: ("Rig_Medium_General" not in path.name, "Rig_Medium" not in str(path), str(path)))
    if args.first_medium:
        paths = [path for path in paths if path.name == "Rig_Medium_General.glb"][:1]
    for path in paths:
        provider, pack = path.relative_to(PACKS).parts[:2]
        doc, blob = read_document(path)
        if not doc.get("animations"):
            continue
        mapping, profile = bone_mapping(doc)
        # 静态物件与非人形动画不属于统一人物预览。
        if not mapping:
            continue
        source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        for clip in doc["animations"]:
            record = {"provider": provider, "pack_key": pack, "source_file": str(path.relative_to(ROOT)), "source_sha256": source_hash, "source_clip": clip["name"]}
            try:
                times, poses, normalization = retarget(doc, blob, clip, canonical, canonical_blob)
                signature = hashlib.sha256(json.dumps([times, poses], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                record["normalization"] = normalization
                key = "pa-" + signature[:24]
                if signature in unique:
                    record.update(status="duplicate", asset_key=unique[signature]["asset_key"], output_clip=unique[signature]["clip"])
                else:
                    label = provider + "/" + profile + "/" + clip["name"]
                    output = BUILTIN / (key + ".glb")
                    write_clip(output, label, nodes, roots, times, poses)
                    animation = {"clip": label, "asset_key": key, "url": "/api/v1/assets/" + key}
                    unique[signature] = animation
                    manifest["animations"].append(animation)
                    manifest["assets"].append({"key": key, "name": label, "kind": "animation", "format": "glb", "url": animation["url"], "provider": provider, "pack_key": pack, "source_url": ("https://kaylousberg.itch.io/" if provider == "kaykit" else "https://kenney.nl/assets/") + pack, "license": "CC0-1.0"})
                    record.update(status="imported", asset_key=key, output_clip=label, output_sha256=hashlib.sha256(output.read_bytes()).hexdigest())
                print(record["status"], path.name, clip["name"], flush=True)
            except Exception as error:
                record.update(status="failed", reason=str(error))
                print("failed", path.name, clip["name"], str(error), flush=True)
            manifest["sources"].append(record)
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    manifest["counts"] = {"source_clips": len(manifest["sources"]), "unique_clips": len(unique), "failed_clips": sum(item["status"] == "failed" for item in manifest["sources"])}
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest["counts"]), flush=True)


if __name__ == "__main__":
    main()
