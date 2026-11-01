"""将官方人物动作离线映射到统一身体骨架，源网格不进入动作产物。"""

import argparse
import base64
import bisect
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / ".local/3d-sources/provider-packs"
BUILTIN = ROOT / "internal/assets/builtin"
MANIFEST = ROOT / "internal/assets/provider-animation-manifest.json"
NORMALIZATION_VERSION = 3  # 固定水平根位置，并以实际骨架、曲线与来源族确定交付身份。
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
    if "Hips" in names and "LeftArm" in names:
        aliases = {"root": "Root", "hips": "Hips", "spine": "Spine", "chest": "Chest", "head": "Head"}
        for side, prefix in (("l", "Left"), ("r", "Right")):
            for target, source in (("upperarm", "Arm"), ("lowerarm", "ForeArm"), ("wrist", "Hand"), ("hand", "Hand"), ("upperleg", "UpLeg"), ("lowerleg", "Leg"), ("foot", "Foot"), ("toes", "Toes")):
                aliases[target + "." + side] = prefix + source
        return {target: names[source] for target, source in aliases.items() if source in names}, "kenney-fbx-humanoid"
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
        source_root_motion = source_world[mapping["root"]].translation - source_rest[mapping["root"]].translation if "root" in mapping else Vector((0, 0, 0))
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
                    movement = source_world[source_index].translation - source_rest[source_index].translation
                    # 只剥离水平根位移，保留跳跃高度和髋部相对身体的摇摆。
                    movement.x -= source_root_motion.x
                    movement.z -= source_root_motion.z
                    position = rest.translation + movement * ratio
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
    return times, output, {"profile": profile, "method": "global-bind-rotation-delta-with-canonical-segment-lengths", "translation_scale": ratio, "fps": 30, "mapped_bones": {name: doc["nodes"][index]["name"] for name, index in mapping.items()}, "root_motion": "horizontal-root-removed-from-root-and-hips", "normalization_version": NORMALIZATION_VERSION}


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


# 曲线身份与来源名称分开，相同实际轨道可共享已交付资源。
def curve_signature(times, poses):
    return hashlib.sha256(json.dumps([times, poses], sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# 只从已审核清单选择，未知批次或源不能静默变成全量扫描。
def select_sources(configuration, batches, only):
    available = {batch["key"]: batch for batch in configuration["batches"]}
    for key in batches:
        if key not in available:
            raise ValueError("未知动作批次: " + key)
    sources = [source for key in batches for source in available[key]["sources"]]
    if only:
        selected = [source for source in sources if source["source_file"] in only]
        unknown = set(only) - {source["source_file"] for source in selected}
        if unknown:
            raise ValueError("选择的源不在审核批次: " + ", ".join(sorted(unknown)))
        sources = selected
    return list({source["source_file"]: source for source in sources}.values())


# 清单按源片段核对剩余范围，未启动的片段不会混进失败或成功数量。
def save_progress(configuration, manifest, records, path):
    pending, batches = [], []
    seen_assets = set()
    for record in records.values():
        if record["status"] in {"imported", "duplicate"}:
            key = record["asset_key"]
            record["status"] = "duplicate" if key in seen_assets else "imported"
            seen_assets.add(key)
    # 活动作只来自当前成功记录；历史资产与文件继续保留供恢复和追溯。
    manifest["animations"] = [item for item in manifest["animations"] if item["asset_key"] in seen_assets]
    for batch in configuration["batches"]:
        counts = {"imported": 0, "duplicate": 0, "failed": 0, "pending": 0}
        for source in batch["sources"]:
            for clip in source["clips"]:
                record = records.get((source["source_file"], clip))
                status = record["status"] if record else "pending"
                counts[status] += 1
                if status == "pending":
                    pending.append({"batch": batch["key"], "source_file": source["source_file"], "source_clip": clip})
        batches.append({"key": batch["key"], **counts})
    manifest["sources"] = list(records.values())
    manifest["pending"] = pending
    manifest["batches"] = batches
    manifest["excluded_sources"] = configuration.get("excluded_sources", [])
    manifest["excluded_clips"] = [{"source_file": source["source_file"], **clip} for batch in configuration["batches"] for source in batch["sources"] for clip in source.get("excluded_clips", [])]
    manifest["counts"] = {
        "source_clips": len(records), "unique_clips": len(manifest["animations"]),
        "failed_clips": sum(item["status"] == "failed" for item in records.values()),
        "duplicate_clips": sum(item["status"] == "duplicate" for item in records.values()),
        "pending_clips": len(pending), "total_source_clips": sum(sum(item[key] for key in ("imported", "duplicate", "failed", "pending")) for item in batches),
    }
    manifest["complete"] = not pending and not manifest["counts"]["failed_clips"]
    manifest["completed_scope"] = [item["key"] for item in batches if not item["pending"] and not item["failed"]]
    manifest["remaining_scope"] = [item["key"] for item in batches if item["pending"] or item["failed"]]
    next_batch = manifest["remaining_scope"][0] if manifest["remaining_scope"] else (batches[0]["key"] if batches else "")
    manifest["checkpoint"] = {
        "command": "/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/import-provider-animations.py -- --batch " + next_batch,
        "note": "按审核批次增量恢复；只有清单中的全部人形来源处理成功后才标记完成。",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temporary:
        json.dump(manifest, temporary, ensure_ascii=False, indent=2)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)


# 分批处理只追加新资源；恢复必须核对源和产物字节，单源失败仍保留其他成果。
def import_sources(configuration, sources, manifest_path=MANIFEST, output_directory=BUILTIN, canonical_path=BUILTIN / "character-medium-v1.glb"):
    canonical, canonical_blob = read_document(canonical_path)
    canonical_hash = hashlib.sha256(canonical_path.read_bytes()).hexdigest()
    nodes, roots = skeleton_nodes(canonical)
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "body_key": "kaykit-medium-body-v1", "rig_key": "kaykit-adventurers-medium-v1",
        "sources": [], "assets": [], "animations": [],
    }
    manifest["canonical_sha256"] = canonical_hash
    families = {provider: {"provider": provider, "source_url": metadata.get("source_url"), "license": metadata.get("license")}
                for provider, metadata in configuration.get("shared_asset_metadata", {}).items()}
    records = {(item["source_file"], item["source_clip"]): item for item in manifest["sources"]}
    # 全局hash只能说明当前输入；未处理批次仍须保留各自的旧骨架证明。
    for record in records.values():
        if record["status"] in {"imported", "duplicate"} and (record.get("canonical_sha256") != canonical_hash or record.get("shared_asset_metadata") != families.get(record["provider"])):
            record["status"] = "pending"
    animations = {item["asset_key"]: item for item in manifest["animations"]}
    assets = {item["key"]: item for item in manifest["assets"]}
    output_hashes = {item["asset_key"]: item["output_sha256"] for item in records.values() if item.get("output_sha256")}
    output_directory.mkdir(parents=True, exist_ok=True)
    converted = {}
    for source in sources:
        path = ROOT / source["source_file"]
        try:
            family = families.get(source["provider"])
            if not family or not family["source_url"] or not family["license"] or family["license"] != source["license"]:
                raise ValueError("来源与共享动作出处或许可配置不匹配: " + source["source_file"])
            source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            if source_hash != source["sha256"]:
                raise ValueError("来源字节与审核快照不一致: " + source["source_file"])
            conversion = None
            if source.get("format") == "fbx":
                if source_hash not in converted:
                    spec = importlib.util.spec_from_file_location("provider_animation_fbx", Path(__file__).with_name("provider-animation-fbx.py"))
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    converted[source_hash] = module.read_fbx_document(path, read_document)
                doc, blob, conversion = converted[source_hash]
            else:
                doc, blob = read_document(path)
            clips = {clip["name"]: clip for clip in doc.get("animations", [])}
            missing = set(source["clips"]) - clips.keys()
            if missing:
                raise ValueError("来源片段缺失: " + ", ".join(sorted(missing)))
        except Exception as error:
            for name in source["clips"]:
                records[(source["source_file"], name)] = {"provider": source["provider"], "pack_key": source["pack_key"], "source_url": source["source_url"], "license": source["license"], "source_file": source["source_file"], "source_sha256": source["sha256"], "source_clip": name, "canonical_sha256": canonical_hash, "status": "failed", "reason": str(error)}
            save_progress(configuration, manifest, records, manifest_path)
            continue
        for name in source["clips"]:
            identity = (source["source_file"], name)
            previous = records.get(identity, {})
            record = {"provider": source["provider"], "pack_key": source["pack_key"], "source_url": source["source_url"], "license": source["license"], "source_file": source["source_file"], "source_sha256": source_hash, "source_clip": name, "canonical_sha256": canonical_hash, "shared_asset_metadata": family}
            try:
                if previous.get("canonical_sha256") == canonical_hash and previous.get("shared_asset_metadata") == family and previous.get("normalization_version") == NORMALIZATION_VERSION and previous.get("status") in {"imported", "duplicate"} and previous.get("source_sha256") == source_hash:
                    previous_path = output_directory / (previous["asset_key"] + ".glb")
                    expected = previous.get("output_sha256") or output_hashes.get(previous["asset_key"])
                    if previous_path.exists() and expected and hashlib.sha256(previous_path.read_bytes()).hexdigest() != expected:
                        raise ValueError("已交付动作字节损坏: " + previous_path.name)
                    if previous_path.exists() and expected:
                        continue
                times, poses, normalization = retarget(doc, blob, clips[name], canonical, canonical_blob)
                if conversion:
                    normalization["source_conversion"] = conversion
                signature = curve_signature(times, poses)
                # 相同轨道在不同rest节点上会生成不同GLB，身份必须包含实际骨架。
                asset_identity = hashlib.sha256(json.dumps([family, nodes, roots, signature], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                key = "pa-" + asset_identity[:24]
                output = output_directory / (key + ".glb")
                existing = animations.get(key)
                # 片段名也属于GLB字节，不能由哪一个来源先执行决定。
                label = "canonical/" + key
                write_clip(output, label, nodes, roots, times, poses)
                output_hash = hashlib.sha256(output.read_bytes()).hexdigest()
                if key in output_hashes and output_hashes[key] != output_hash:
                    raise ValueError("同一动作身份的既有校验值不同: " + key)
                animation = {"clip": label, "asset_key": key, "url": "/api/v1/assets/" + key}
                animations[key] = animation
                # 同一作者族内共享产物，精确原包与来源仍保留在每条source记录中。
                assets[key] = {"key": key, "name": label, "kind": "animation", "format": "glb", "url": animation["url"], **family}
                record.update(status="duplicate" if existing else "imported", normalization=normalization, normalization_version=NORMALIZATION_VERSION, asset_key=key, output_clip=label, output_sha256=output_hash, curve_sha256=signature)
                output_hashes[key] = output_hash
                print("动作整理完成", record["status"], path.name, name, flush=True)
            except Exception as error:
                record.update(status="failed", reason=str(error))
                print("动作整理失败", path.name, name, str(error), flush=True)
            records[identity] = record
        manifest["animations"] = list(animations.values())
        manifest["assets"] = list(assets.values())
        save_progress(configuration, manifest, records, manifest_path)
    save_progress(configuration, manifest, records, manifest_path)
    return manifest


# CLI必须显式选择范围；列表只读取配置，不加载Blender或改动交付清单。
def main(argv=None):
    default_sources = Path(__file__).with_name("provider-animation-sources.json")
    configuration = json.loads(default_sources.read_text())
    parser = argparse.ArgumentParser(description=configuration["content"]["description"])
    parser.add_argument("--batch", action="append", default=[])
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--first-medium", action="store_true")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--output", type=Path, default=BUILTIN)
    parser.add_argument("--sources", type=Path, default=default_sources)
    arguments = argv if argv is not None else (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    args = parser.parse_args(arguments)
    configuration = json.loads(args.sources.read_text())
    if args.list:
        print(json.dumps([{ "key": batch["key"], "sources": len(batch["sources"]), "clips": sum(len(item["clips"]) for item in batch["sources"])} for batch in configuration["batches"]], ensure_ascii=False, indent=2))
        return 0
    batches = args.batch + (["kaykit-medium-general"] if args.first_medium else [])
    if args.all:
        batches = [batch["key"] for batch in configuration["batches"]]
    if not batches:
        parser.error(configuration["content"]["select_batch"])
    try:
        sources = select_sources(configuration, batches, args.only)
        manifest = import_sources(configuration, sources, args.manifest, args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(manifest["counts"]), flush=True)
    return int(manifest["counts"]["failed_clips"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
