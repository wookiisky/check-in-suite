"""用椭圆截面、真实裸手及圆润腕接合生成低面数身体，保留标准骨架。"""
from __future__ import annotations

import math
import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from bpy.types import Object
    from mathutils import Vector


# 骨轴参考冻结实际身体表面，避免生成步骤依赖正在改写的产物。
class SkinningSource(TypedDict):
    path: str  # 仓库相对的不可变模型位置。
    sha256: str  # 模型字节的校验值。
    nodes: list[str]  # 含肩部、臂和掌的实际身体节点。


# 裸手选面来源必须是已核实的皮肤区域，不能复用手套轮廓改色。
class HandSurfaceSource(TypedDict):
    path: str  # 已标准化的真实裸手来源。
    sha256: str  # 该来源模型的字节校验值。
    node: str  # 含真实掌指的源节点。
    uv_regions: list[list[float]]  # 源纹理中的皮肤矩形，依次为u0/u1/v0/v1。


# 两个圆封口分别跟随前臂和掌骨，用重叠体积承受大角度屈腕。
class WristJoint(TypedDict):
    forearm_cap_sections: list[list[float]]  # 相对掌骨起点的纵向位置与椭圆半径。
    palm_cap_sections: list[list[float]]  # 从源掌腕口向前臂延伸的闭合截面。


# 制作配方保存外形参数，生成器只负责连通拓扑和标准骨架绑定。
class BodyProfile(TypedDict):
    torso_sections: list[list[float]]  # 从腰部往颈部的高度与椭圆半径。
    arm_sections: list[list]  # 骨段名、骨段位置及截面前后/上下半径。
    hand_surface_reference: HandSurfaceSource  # 已核实的源裸手、纹理区域及不可变校验值。
    wrist_joint: WristJoint  # 前臂与掌根的低面数圆封口截面。
    skin_color: list[float]  # 线性空间统一皮肤颜色，不使用衣物纹理。
    skin_roughness: float  # 统一皮肤表面粗糙度。
    arm_skinning_reference: SkinningSource  # 不可变骷髅表面及其已验证的共同蒙皮。


# 临时网格统一计算肩部法线；躯干肩臂连通，圆润掌根独立闭合。
class BodyMesh:
    def __init__(self) -> None:
        self.points: list[tuple[float, float, float]] = []  # 标准骨架局部空间中的顶点。
        self.weights: list[dict[str, float]] = []  # 接口重复顶点共享同一权重。
        self.faces: list[tuple[int, ...]] = []  # 躯干、臂和闭合掌面的统一列表。
        self.regions: list[str] = []  # 与面一一对应的稳定身体分区。
        self.arm_rings: list[list[int]] = []  # 同一臂截面使用统一权重，防止环内撕扯。

    # 截面顶点只定义一次，后续连接面直接引用。
    def ring(self, points, weights, arm_section=False):
        indices = []
        for point, skin in zip(points, weights):
            indices.append(len(self.points))
            self.points.append(tuple(point))
            self.weights.append({name: amount for name, amount in skin.items() if amount > 1e-7})
        if arm_section:
            self.arm_rings.append(indices)
        return indices

    # 相邻等点数截面连接，不在躯干肩部连接处产生封口。
    def bridge(self, first, second, region):
        for index in range(len(first)):
            following = (index + 1) % len(first)
            self.faces.append((first[index], first[following], second[following], second[index]))
            self.regions.append(region)

    # 腕部圆端和颈顶收口，腰口保留原腿部接口。
    def cap(self, ring, region):
        self.faces.append(tuple(reversed(ring)))
        self.regions.append(region)


# 不等点数腰环按极角连接，原44点切口不必扩散成高细分躯干。
def join_waist(mesh, waist, upper):
    angle = lambda index: math.atan2(mesh.points[index][1], mesh.points[index][0]) % math.tau
    first, second = sorted(waist, key=angle), sorted(upper, key=angle)
    i = j = 0
    while i < len(first) or j < len(second):
        a, b = first[i % len(first)], second[j % len(second)]
        next_a = angle(first[(i + 1) % len(first)]) + (math.tau if i + 1 >= len(first) else 0) if i < len(first) else float('inf')
        next_b = angle(second[(j + 1) % len(second)]) + (math.tau if j + 1 >= len(second) else 0) if j < len(second) else float('inf')
        if next_a < next_b:
            face = (a, first[(i + 1) % len(first)], b)
            i += 1
        else:
            face = (a, second[(j + 1) % len(second)], b)
            j += 1
        mesh.faces.append(face)
        mesh.regions.append('torso')


# 以真实骨链为轴，八边截面足以表达简化手臂而不保留衣物凸环。
def build_arm(mesh, rig, side, socket, profile):
    from mathutils import Vector
    sign = 1 if side == 'l' else -1
    previous = socket
    for segment, amount, radius_y, radius_z in profile['arm_sections']:
        bone = rig.data.bones[segment + '.' + side]
        center = bone.head_local.lerp(bone.tail_local, amount)
        axis = (bone.tail_local - bone.head_local).normalized() * sign
        across = Vector((0, 0, 1)).cross(axis).normalized()
        points = [center + across * (radius_y * math.cos(-3 * math.pi / 4 + index * math.pi / 4)) + Vector((0, 0, radius_z * math.sin(-3 * math.pi / 4 + index * math.pi / 4))) for index in range(8)]
        ring = mesh.ring(points, [{}] * 8, arm_section=True)
        mesh.bridge(previous, ring, 'arms')
        previous = ring
    # 前臂以圆润端面闭合，掌根独立转动时仍与它保持体积重叠。
    origin = rig.data.bones['hand.' + side].head_local
    for dx, radius_y, radius_z in profile['wrist_joint']['forearm_cap_sections']:
        points = [origin + Vector((sign * dx, radius_y * math.cos(-3 * math.pi / 4 + index * math.pi / 4), radius_z * math.sin(-3 * math.pi / 4 + index * math.pi / 4))) for index in range(8)]
        ring = mesh.ring(points, [{}] * 8, arm_section=True)
        mesh.bridge(previous, ring, 'arms')
        previous = ring
    mesh.cap(previous, 'arms')


# 真正的源裸手保留掌指形状，仅在原腕口补圆润闭合端。
def append_reference_hands(mesh, rig, profile):
    import bpy
    from collections import Counter
    from mathutils import Vector

    reference = profile['hand_surface_reference']
    path = Path(__file__).resolve().parents[1] / reference['path']
    if hashlib.sha256(path.read_bytes()).hexdigest() != reference['sha256']:
        raise ValueError('真实裸手参考校验值不符')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - before
    try:
        source = next(obj for obj in added if obj.type == 'MESH' and (obj.name == reference['node'] or obj.name.startswith(reference['node'] + '.')))
        source_rig = next(obj for obj in added if obj.type == 'ARMATURE')
        for side in ['l', 'r']:
            source_bone = source_rig.data.bones['hand.' + side].matrix_local
            target_bone = rig.data.bones['hand.' + side].matrix_local
            if max(abs(a - b) for source_row, target_row in zip(source_bone, target_bone) for a, b in zip(source_row, target_row)) > 1e-4:
                raise ValueError('裸手参考与标准掌骨绑定姿势不一致')
        uv = source.data.uv_layers.active.data
        vertices, faces = {}, []
        for face in source.data.polygons:
            center = sum((uv[index].uv for index in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
            if not any(u0 <= center.x <= u1 and v0 <= center.y <= v1 for u0, u1, v0, v1 in reference['uv_regions']):
                continue
            indices = []
            for index in face.vertices:
                point = source.matrix_world @ source.data.vertices[index].co
                key = tuple(round(value, 6) for value in point)
                if key not in vertices:
                    side = 'l' if point.x >= 0 else 'r'
                    vertices[key] = mesh.ring([point], [{'hand.' + side: 1.0}])[0]
                indices.append(vertices[key])
            faces.append(tuple(indices))
        if not faces:
            raise ValueError('真实裸手参考没有选出皮肤面')
        mesh.faces.extend(faces)
        mesh.regions.extend(['hands'] * len(faces))
        edges = Counter(tuple(sorted((a, b))) for face in faces for a, b in zip(face, face[1:] + face[:1]))
        boundary = {index for edge, count in edges.items() if count == 1 for index in edge}
        for sign, side in [(1, 'l'), (-1, 'r')]:
            origin = rig.data.bones['hand.' + side].head_local
            ring = [index for index in boundary if mesh.points[index][0] * sign > 0]
            ring.sort(key=lambda index: math.atan2(mesh.points[index][2] - origin.z, mesh.points[index][1] - origin.y))
            angles = [math.atan2(mesh.points[index][2] - origin.z, mesh.points[index][1] - origin.y) for index in ring]
            for dx, radius_y, radius_z in profile['wrist_joint']['palm_cap_sections']:
                points = [origin + Vector((sign * dx, radius_y * math.cos(angle), radius_z * math.sin(angle))) for angle in angles]
                following = mesh.ring(points, [{'hand.' + side: 1.0}] * len(points))
                mesh.bridge(ring, following, 'hands')
                ring = following
            mesh.cap(ring, 'hands')
        return {'sha256': reference['sha256'], 'source_faces': len(faces), 'wrist_boundary_vertices': len(boundary)}
    finally:
        for obj in added:
            bpy.data.objects.remove(obj, do_unlink=True)


# 共享的一维权重场只保留数学数据，重置Blender场景不会使引用失效。
class ArmSkinningReference:
    def __init__(self, sections: dict[int, list[tuple[float, dict[str, float]]]], sha256: str) -> None:
        self.sections: dict[int, list[tuple[float, dict[str, float]]]] = sections  # 左右骨轴各采样位置的固定蒙皮。
        self.sha256: str = sha256  # 实际读取的不可变标准资源校验值。

    # 同一纵向位置统一插值，截面角度不能改变腕掌绑定。
    def sample(self, point: Vector, hand: bool = False) -> dict[str, float]:
        side = 'l' if point.x >= 0 else 'r'
        if hand:
            return {'hand.' + side: 1.0}
        sections = self.sections[1 if point.x >= 0 else -1]
        x = abs(point.x)
        if x <= sections[0][0]:
            return dict(sections[0][1])
        for (start, first), (end, second) in zip(sections, sections[1:]):
            if x <= end:
                amount = (x - start) / (end - start)
                return {name: first.get(name, 0) * (1 - amount) + second.get(name, 0) * amount for name in first.keys() | second.keys()}
        return dict(sections[-1][1])


# 衣物与身体复用此入口，参考骨段的起点、中点及末端确定纵向采样。
def load_arm_skinning_reference(reference: SkinningSource) -> ArmSkinningReference:
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.interpolate import poly_3d_calc

    path = Path(__file__).resolve().parents[1] / reference['path']
    if hashlib.sha256(path.read_bytes()).hexdigest() != reference['sha256']:
        raise ValueError('标准手臂蒙皮参考校验值不符')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - before
    points, triangles, weights = [], [], []
    try:
        rig = next(obj for obj in added if obj.type == 'ARMATURE')
        for name in reference['nodes']:
            obj = next(obj for obj in added if obj.type == 'MESH' and (obj.name == name or obj.name.startswith(name + '.')))
            offset = len(points)
            points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
            weights.extend({obj.vertex_groups[item.group].name: item.weight for item in vertex.groups} for vertex in obj.data.vertices)
            obj.data.calc_loop_triangles()
            triangles.extend(tuple(offset + index for index in triangle.vertices) for triangle in obj.data.loop_triangles)
        tree = BVHTree.FromPolygons(points, triangles, all_triangles=True)
        sections = {}
        for sign, side in [(1, 'l'), (-1, 'r')]:
            samples = {}
            for name in ['upperarm', 'lowerarm', 'wrist', 'hand']:
                bone = rig.data.bones[name + '.' + side]
                for amount in [0, .5, 1]:
                    point = rig.matrix_world @ bone.head_local.lerp(bone.tail_local, amount)
                    samples[round(abs(point.x), 6)] = point
            shoulder = rig.matrix_world @ rig.data.bones['upperarm.' + side].head_local
            shoulder.x -= sign * (rig.data.bones['upperarm.' + side].length / 4)
            samples[abs(shoulder.x)] = shoulder
            sections[sign] = []
            for x, point in sorted(samples.items()):
                hit, _, face, _ = tree.find_nearest(point)
                triangle = triangles[face]
                amounts = poly_3d_calc([points[vertex] for vertex in triangle], hit)
                transferred = {}
                for vertex, amount in zip(triangle, amounts):
                    for name, weight in weights[vertex].items():
                        transferred[name] = transferred.get(name, 0) + weight * max(0, amount)
                total = sum(transferred.values())
                sections[sign].append((x, {name: weight / total for name, weight in transferred.items() if weight > 1e-7}))
            # 掌部独立闭合，前臂末端随lowerarm刚性；不跨越约140°掌转动混皮。
            lowerarm = rig.data.bones['lowerarm.' + side]
            forearm = (abs(lowerarm.head_local.x) + abs(lowerarm.tail_local.x)) / 2
            sections[sign] = [(x, weights) for x, weights in sections[sign] if x < forearm - 1e-6]
            sections[sign].append((forearm, {'lowerarm.' + side: 1.0}))
        return ArmSkinningReference(sections, reference['sha256'])
    finally:
        for obj in added:
            bpy.data.objects.remove(obj, do_unlink=True)


# 分区共享点只改一次，环内统一权重避免Read腕根出现交叉尖片。
def transfer_arm_weights(mesh, profile):
    from mathutils import Vector
    reference = load_arm_skinning_reference(profile['arm_skinning_reference'])
    selected = {index for face, region in zip(mesh.faces, mesh.regions) if region in ['arms', 'hands'] for index in face}
    for index in selected:
        mesh.weights[index] = reference.sample(Vector(mesh.points[index]))
    for ring in mesh.arm_rings:
        center = sum((Vector(mesh.points[index]) for index in ring), Vector()) / len(ring)
        weights = reference.sample(center)
        for index in ring:
            mesh.weights[index] = weights
    # 握指向内折回后不再服从x纵向顺序，整掌及共用腕口随掌骨保持握形。
    hands = {index for face, region in zip(mesh.faces, mesh.regions) if region == 'hands' for index in face}
    for index in hands:
        mesh.weights[index] = reference.sample(Vector(mesh.points[index]), hand=True)
    return {'sha256': reference.sha256, 'vertices': len(selected), 'method': 'shared-bone-axis-sections'}


# 躯干肩臂生成后沿原节点拆开，独立闭合的真实掌部维持既有显隐契约。
def apply_human_body(objects: dict[str, Object], rig: Object, profile: BodyProfile) -> dict:
    import bpy
    import bmesh
    from mathutils import Matrix

    mesh = BodyMesh()
    material = bpy.data.materials.new('Human_Bare_Skin')
    material.diffuse_color = profile['skin_color']
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = profile['skin_color']
    shader.inputs['Roughness'].default_value = profile['skin_roughness']
    legs = objects['body_legs']
    height = max((legs.matrix_world @ vertex.co).z for vertex in legs.data.vertices)
    seam = {}
    for vertex in legs.data.vertices:
        point = legs.matrix_world @ vertex.co
        if abs(point.z - height) < 1e-5:
            weights = {legs.vertex_groups[item.group].name: item.weight for item in vertex.groups}
            seam[tuple(round(value, 7) for value in point)] = (point.copy(), weights)
    waist = mesh.ring([entry[0] for entry in seam.values()], [entry[1] for entry in seam.values()])
    rings = []
    for z, radius_x, radius_y in profile['torso_sections']:
        points = [(radius_x * math.cos(index * math.tau / 12), radius_y * math.sin(index * math.tau / 12), z) for index in range(12)]
        chest = min(1.0, max(0.0, (z - .78) / .3))
        rings.append(mesh.ring(points, [{'spine': 1 - chest, 'chest': chest}] * 12))
    join_waist(mesh, waist, rings[0])
    for row in range(len(rings) - 1):
        for index in range(12):
            if row in [1, 2] and index in [11, 0, 5, 6]:
                continue
            following = (index + 1) % 12
            mesh.faces.append((rings[row][index], rings[row][following], rings[row + 1][following], rings[row + 1][index]))
            mesh.regions.append('torso')
    mesh.cap(rings[-1], 'torso')
    for side, index in [('l', 0), ('r', 6)]:
        a, b, c = (index - 1) % 12, index, (index + 1) % 12
        if side == 'r':
            a, c = c, a
        socket = [rings[1][a], rings[1][b], rings[1][c], rings[2][c], rings[3][c], rings[3][b], rings[3][a], rings[2][a]]
        build_arm(mesh, rig, side, socket, profile)
    hand_evidence = append_reference_hands(mesh, rig, profile)
    skinning = transfer_arm_weights(mesh, profile)
    unified = bpy.data.meshes.new('_continuous_human_body')
    unified.from_pydata(mesh.points, [], mesh.faces)
    unified.update()
    bm = bmesh.new()
    bm.from_mesh(unified)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(unified)
    bm.free()
    normals = [tuple(vertex.normal) for vertex in unified.vertices]
    evidence = {'method': 'elliptic-body-reference-fists-rounded-wrist-joints', 'waist_vertices': len(waist), 'arm_skinning': skinning, 'hand_surface': hand_evidence, 'regions': {}}
    for region in ['torso', 'arms', 'hands']:
        name = 'body_' + region
        indices = [index for index, value in enumerate(mesh.regions) if value == region]
        used = sorted({vertex for index in indices for vertex in unified.polygons[index].vertices})
        mapping = {old: new for new, old in enumerate(used)}
        data = bpy.data.meshes.new(name + '_mesh')
        data.from_pydata([mesh.points[index] for index in used], [], [tuple(mapping[v] for v in unified.polygons[index].vertices) for index in indices])
        data.materials.append(material)
        data.update()
        for face in data.polygons:
            face.use_smooth = True
        data.normals_split_custom_set_from_vertices([normals[index] for index in used])
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.parent = rig
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_world = Matrix.Identity(4)
        modifier = obj.modifiers.new('标准身体蒙皮', 'ARMATURE')
        modifier.object = rig
        for vertex, old in enumerate(used):
            for bone, weight in mesh.weights[old].items():
                group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
                group.add([vertex], weight, 'REPLACE')
        bpy.data.objects.remove(objects[name], do_unlink=True)
        obj.name = name
        objects[name] = obj
        evidence['regions'][region] = {'vertices': len(data.vertices), 'faces': len(data.polygons)}
    bpy.data.meshes.remove(unified)
    return evidence
