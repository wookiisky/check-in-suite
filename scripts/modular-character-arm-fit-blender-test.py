"""用最终 GLB、真实动作和完整身体实体检查袖子、护臂外表面的穿入。"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
POSES = [('rest', 0), ('idle', 13), ('cheer', 11), ('cheer', 21),
         ('cheer', 31), ('read', 24), ('read', 48), ('read', 72)]
PENETRATION_TOLERANCE = .003
MAXIMUM_BURIED_AREA_RATIO = .01
MAXIMUM_PENETRATION = .01
ARM_BONES = ('upperarm', 'lowerarm', 'wrist', 'hand')
GEOMETRY_DOMAIN = 'same-arm-component-volume-v2'


# 试制目录只覆盖同名资源，未修改的身体与动作仍取正式目录；报告保存实际路径和哈希。
def asset_path(key, directories):
    candidates = [directory / (key + '.glb') for directory in directories]
    return next((path for path in candidates if path.exists()), candidates[0])


# 保存对象引用后统一改名，避免不同 GLB 的同名节点被 Blender 自动改写。
def import_model(bpy, path, prefix):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    added = set(bpy.data.objects) - before
    meshes = {obj.name: obj for obj in added if obj.type == 'MESH'}
    rig = next(obj for obj in added if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    for obj in added:
        obj.name = prefix + '_' + obj.name
    return meshes, rig


# 区域由实际骨骼关节的位置决定，避免用衣服自身的整体范围证明适配。
def arm_region(point, bones):
    shoulder, elbow, wrist, hand, tip = bones
    distance = abs(point.x)
    upper_length = abs(elbow.x - shoulder.x)
    lower_length = abs(wrist.x - elbow.x)
    if distance < abs(shoulder.x) + upper_length * .2:
        return 'shoulder'
    if distance < abs(elbow.x) - upper_length * .2:
        return 'upperarm'
    if distance < abs(elbow.x) + lower_length * .2:
        return 'elbow'
    if distance < abs(wrist.x) - lower_length * .1:
        return 'forearm'
    return 'wrist' if distance < abs(hand.x) else 'hand'


# 沿骨链求径向；衣物内壁、袖口封边和朝向肩窝的连接面不属于向外展示的表面。
def arm_radial(point, bones):
    closest, radial = float('inf'), None
    for start, end in zip(bones, bones[1:]):
        axis = end - start
        amount = max(0, min(1, (point - start).dot(axis) / axis.length_squared))
        candidate = point - (start + axis * amount)
        perpendicular = candidate - axis * (candidate.dot(axis) / axis.length_squared)
        if candidate.length_squared < closest:
            closest, radial = candidate.length_squared, perpendicular
    return radial.normalized() if radial.length > .000001 else radial


# 使用当前骨链作为观察轴；最近面法线在开口和边缘之外不能可靠证明点在身体内部。
def arm_axis_point(point, bones):
    nearest, distance = None, float('inf')
    for start, end in zip(bones, bones[1:]):
        axis = end - start
        amount = max(0, min(1, (point - start).dot(axis) / axis.length_squared))
        candidate = start + axis * amount
        if (point - candidate).length_squared < distance:
            nearest, distance = candidate, (point - candidate).length_squared
    return nearest


# 只标记真实衣物已有的外侧面，不要求原本的开口生长出袖子或遮住裸露皮肤。
def garment_samples(objects, rig):
    from mathutils import Vector

    bones = {side: [rig.data.bones[name + side].head_local.copy() for name in ARM_BONES]
             + [rig.data.bones['hand' + side].tail_local.copy()] for side in ['.l', '.r']}
    result = []
    for obj in objects:
        obj.data.calc_loop_triangles()
        for triangle in obj.data.loop_triangles:
            vertices = [obj.matrix_world @ obj.data.vertices[index].co for index in triangle.vertices]
            center = sum(vertices, Vector()) / 3
            side = '.l' if center.x >= 0 else '.r'
            arm_weight = sum(sum(group.weight for group in obj.data.vertices[index].groups
                                 if obj.vertex_groups[group.group].name in [name + side for name in ARM_BONES])
                             for index in triangle.vertices) / 3
            if arm_weight <= .5:
                continue
            normal = (obj.matrix_world.to_3x3() @ triangle.normal).normalized()
            if normal.dot(arm_radial(center, bones[side])) <= .25:
                continue
            area = (vertices[1] - vertices[0]).cross(vertices[2] - vertices[0]).length / 2
            if area <= .0000000001:
                continue
            result.append((obj, triangle.index, side, arm_region(center, bones[side]), area))
    return result


# 对身体和衣物使用同一帧的真实蒙皮结果；不沿用加工器声称的包络或位移。
def evaluated_mesh(bpy, obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    triangles = [tuple(triangle.vertices) for triangle in mesh.loop_triangles]
    evaluated.to_mesh_clear()
    return points, triangles


# 源位置用于恢复跨节点连接；不按衣物变化后的坐标重新决定身体分区。
def connected_face_groups(triangles, rest_points):
    welded, identities = {}, []
    for point in rest_points:
        key = tuple(round(value, 5) for value in point)
        if key not in welded:
            welded[key] = len(welded)
        identities.append(welded[key])
    parents = list(range(len(welded)))

    # 共享位置的三角面属于同一实体候选，UV 或法线造成的重复顶点不拆开组件。
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for triangle in triangles:
        first = find(identities[triangle[0]])
        for index in triangle[1:]:
            parents[find(identities[index])] = first
    components = defaultdict(list)
    for index, triangle in enumerate(triangles):
        components[find(identities[triangle[0]])].append(index)
    return list(components.values()), identities


# 体积保留实际动作后坐标，源坐标取整只合并 UV/法线造成的重复拓扑身份。
def volume_components(points, triangles, rest_points):
    import numpy as np

    groups, _ = connected_face_groups(triangles, rest_points)
    coordinates = np.asarray(points, dtype=np.float64)
    result = []
    for indices in groups:
        vertices = coordinates[np.asarray([triangles[index] for index in indices])]
        result.append((vertices, vertices.min(axis=(0, 1)), vertices.max(axis=(0, 1))))
    return result


# 闭合外表面的立体角在内部为 ±4π、外部为零；开放骨缝不凭最近面的延长平面判内部。
def winding_number(point, triangles):
    import numpy as np

    vectors = triangles - np.asarray(point, dtype=np.float64)
    first, second, third = vectors[:, 0], vectors[:, 1], vectors[:, 2]
    lengths = np.linalg.norm(vectors, axis=2)
    determinant = np.einsum('ij,ij->i', first, np.cross(second, third))
    denominator = (lengths.prod(axis=1)
                   + np.einsum('ij,ij->i', first, second) * lengths[:, 2]
                   + np.einsum('ij,ij->i', second, third) * lengths[:, 0]
                   + np.einsum('ij,ij->i', third, first) * lengths[:, 1])
    return float(np.arctan2(determinant, denominator).sum() / (2 * np.pi))


# 按完整组件分别取绝对绕数，重叠或不同朝向的两个骨块不能把彼此的实体体积抵消。
def contains_volume(point, components):
    import numpy as np

    point = np.asarray(point, dtype=np.float64)
    return any(not (np.any(point < lower) or np.any(point > upper))
               and abs(winding_number(point, triangles)) > .5
               for triangles, lower, upper in components)


# 独立骨组件补齐跨区的同侧面；连续人形保留显式 arms/hands，包括纯 Chest 的肩根面。
def select_arm_triangles(triangles, rest_points, arm_weights, explicit_arm_faces):
    groups, _ = connected_face_groups(triangles, rest_points)
    selected = {'.l': [], '.r': []}
    for indices in groups:
        vertices = {index for face in indices for index in triangles[face]}
        sides = [side for side in range(2) if any(arm_weights[index][side] > 0 for index in vertices)]
        if len(sides) == 1:
            selected[['.l', '.r'][sides[0]]].extend(triangles[index] for index in indices)
        elif len(sides) == 2:
            for index in indices:
                if explicit_arm_faces[index]:
                    triangle = triangles[index]
                    side = '.l' if sum(rest_points[vertex].x for vertex in triangle) >= 0 else '.r'
                    selected[side].append(triangle)
        # 纯零 arm 权重的胸、脊柱和髋部组件不能成为手臂专项遮挡体。
    return selected


# 虚拟封口只补实际手臂分区的边界环，不能加入 depth/面积所用的实际表面树。
def closed_arm_volumes(points, triangles, rest_points):
    from mathutils import Vector

    _, identities = connected_face_groups(triangles, rest_points)
    representatives = {}
    for index, identity in enumerate(identities):
        representatives.setdefault(identity, index)
    edges, orientations = Counter(), {}
    for triangle in triangles:
        vertices = [identities[index] for index in triangle]
        for first, second in zip(vertices, vertices[1:] + vertices[:1]):
            if first == second:
                continue
            key = tuple(sorted((first, second)))
            edges[key] += 1
            orientations[key] = first, second
    boundary = {(orientations[key][1], orientations[key][0]) for key, count in edges.items() if count == 1}
    outgoing = defaultdict(list)
    for first, second in boundary:
        outgoing[first].append(second)
    assert all(len(neighbors) == 1 for neighbors in outgoing.values()), '手臂实际分区边界无法组成定向闭环'
    filled_points, filled_rest, filled_faces = list(points), list(rest_points), list(triangles)
    while boundary:
        first, current = next(iter(boundary))
        boundary.remove((first, current))
        loop = [first]
        while current != first:
            loop.append(current)
            following = outgoing[current][0]
            boundary.remove((current, following))
            current = following
        indices = [representatives[identity] for identity in loop]
        center = len(filled_points)
        filled_points.append(sum((points[index] for index in indices), Vector()) / len(indices))
        filled_rest.append(sum((rest_points[index] for index in indices), Vector()) / len(indices))
        filled_faces.extend((indices[index], indices[(index + 1) % len(indices)], center) for index in range(len(indices)))
    return volume_components(filled_points, filled_faces, filled_rest), len(filled_faces) - len(triangles)


# 同侧真实骨体积与显式人形手臂构成专项参考，胸口及另一胳膊的自然接触不进入此域。
def body_surface(bpy, objects, arm_objects):
    from mathutils.bvhtree import BVHTree

    points, triangles, rest_points, arm_weights, explicit_arm_faces = [], [], [], [], []
    for obj in objects:
        posed, faces = evaluated_mesh(bpy, obj)
        offset = len(points)
        points.extend(posed)
        rest_points.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        triangles.extend(tuple(offset + index for index in face) for face in faces)
        names = {group.index: group.name for group in obj.vertex_groups}
        arm_weights.extend(tuple(sum(group.weight for group in vertex.groups
                                     if names[group.group] in [bone + side for bone in ARM_BONES])
                                 for side in ['.l', '.r']) for vertex in obj.data.vertices)
        explicit_arm_faces.extend([obj in arm_objects] * len(faces))
    selected = select_arm_triangles(triangles, rest_points, arm_weights, explicit_arm_faces)
    trees, volumes, counts = {}, {}, {}
    for side, faces in selected.items():
        assert faces, '同侧手臂没有实际身体表面：' + side
        trees[side] = BVHTree.FromPolygons(points, faces, all_triangles=True)
        volumes[side], virtual_faces = closed_arm_volumes(points, faces, rest_points)
        counts[side] = dict(actual_triangles=len(faces), virtual_containment_triangles=virtual_faces)
    return dict(trees=trees, volumes=volumes, counts=counts, inside_cache={})


# 以三顶点、三边中点和中心等权分摊三角面面积，结果是采样估计，不是精确布尔交叠面积。
def measure_samples(bpy, samples, surface, bones):
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    meshes = {obj: evaluated_mesh(bpy, obj) for obj in dict.fromkeys(sample[0] for sample in samples)}
    garment_points, garment_faces = [], []
    for points, triangles in meshes.values():
        offset = len(garment_points)
        garment_points.extend(points)
        garment_faces.extend(tuple(offset + index for index in triangle) for triangle in triangles)
    garment = BVHTree.FromPolygons(garment_points, garment_faces, all_triangles=True)
    regions = defaultdict(lambda: dict(area=0, buried_area=0, maximum_depth=0, samples=0,
                                      triangles=0, hidden_by_garment=0, worst_probes=[]))
    for obj, triangle_index, side, region, area in samples:
        points, triangles = meshes[obj]
        vertices = [points[index] for index in triangles[triangle_index]]
        probes = vertices + [(vertices[index] + vertices[(index + 1) % 3]) / 2 for index in range(3)]
        probes.append(sum(vertices, Vector()) / 3)
        stats = regions[side + '/' + region]
        stats['triangles'] += 1
        for probe_index, point in enumerate(probes):
            direction = point - arm_axis_point(point, bones[side])
            depth = 0
            if direction.length > .000001:
                direction.normalize()
                # 袖口内缘、层叠衣片和壳内层若先被衣物自身挡住，不冒充可见外表面。
                if garment.ray_cast(point + direction * .00002, direction, 2)[0] is not None:
                    stats['hidden_by_garment'] += 1
                    continue
                hit, normal, _, _ = surface['trees'][side].ray_cast(point + direction * .000001, direction, 2)
                # 最近面的半空间与单次射线不能证明内部，尤其骨面被目录分区拆开时。
                if hit is not None and normal.dot(direction) > .1:
                    key = side, tuple(point)
                    if key not in surface['inside_cache']:
                        surface['inside_cache'][key] = contains_volume(point, surface['volumes'][side])
                    if surface['inside_cache'][key]:
                        depth = max(0, (hit - point).dot(direction))
            stats['maximum_depth'] = max(stats['maximum_depth'], depth)
            stats['area'] += area / len(probes)
            stats['samples'] += 1
            if depth > PENETRATION_TOLERANCE:
                stats['buried_area'] += area / len(probes)
                if len(stats['worst_probes']) < 3 or depth > stats['worst_probes'][-1]['depth']:
                    stats['worst_probes'].append(dict(node=obj.name, triangle=triangle_index,
                                                     probe=probe_index, point=list(point), depth=depth))
                    stats['worst_probes'] = sorted(stats['worst_probes'], key=lambda item: item['depth'], reverse=True)[:3]
    for stats in regions.values():
        stats['buried_area_ratio'] = stats['buried_area'] / stats['area'] if stats['area'] else 0
        stats['passed'] = (stats['buried_area_ratio'] <= MAXIMUM_BURIED_AREA_RATIO
                           and stats['maximum_depth'] <= MAXIMUM_PENETRATION)
    return dict(regions)


# 合成反例覆盖骨间空隙、开放分区延长面、真实内部，以及相反朝向的重叠实体。
def verify_containment_geometry():
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    points = [Vector(point) for point in [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                                          (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]]
    triangles = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
                 (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    cube = volume_components(points, triangles, points)
    assert contains_volume(Vector(), cube), '真实内部被体积判定漏掉'
    outside = Vector((1.2, 0, 0))
    assert not contains_volume(outside, cube), '立方体外部被延长平面误判为内部'
    partial = BVHTree.FromPolygons(points, triangles[:2], all_triangles=True)
    nearest, normal, _, _ = partial.find_nearest(outside)
    direction = Vector((-.4, 0, -1)).normalized()
    hit, exit_normal, _, _ = partial.ray_cast(outside, direction, 4)
    assert ((outside - nearest).dot(normal) < 0 and hit is not None
            and exit_normal.dot(direction) > 0), '开放分区反例没有触发旧判定条件'
    separated = [point * .5 + Vector((offset, 0, 0)) for offset in [-2, 2] for point in points]
    separate_faces = triangles + [tuple(index + 8 for index in face) for face in triangles]
    assert not contains_volume(Vector(), volume_components(separated, separate_faces, separated)), '骨间空隙被当成实体'
    overlap = [point + Vector((offset, 0, 0)) for offset in [-.25, .25] for point in points]
    opposite_faces = triangles + [tuple(index + 8 for index in reversed(face)) for face in triangles]
    assert contains_volume(Vector(), volume_components(overlap, opposite_faces, overlap)), '反向组件错误抵消了真实内部'
    open_faces = triangles[:6] + triangles[8:]
    closed, virtual_faces = closed_arm_volumes(points, open_faces, points)
    actual = BVHTree.FromPolygons(points, open_faces, all_triangles=True)
    assert virtual_faces == 4 and contains_volume(Vector(), closed), '虚拟封口没有闭合实际手臂分区'
    assert actual.ray_cast(Vector(), Vector((1, 0, 0)), 3)[0] is None, '检查用封口进入了实际穿出表面'
    arm_weights = [(0, 1)] * 8 + [(0, 0)] * 8
    selected = select_arm_triangles(separate_faces, separated, arm_weights, [True] * 6 + [False] * 18)
    assert len(selected['.r']) == 12 and not selected['.l'], '跨 torso 的同侧骨面被删掉，或纯胸骨未排除'
    same_arm = volume_components(separated, selected['.r'], separated)
    assert not contains_volume(Vector((2, 0, 0)), same_arm), '自然胸口接触被误当同侧手臂体积'
    two_arms = select_arm_triangles(separate_faces, separated, [(0, 1)] * 8 + [(1, 0)] * 8, [True] * 24)
    right_arm = volume_components(separated, two_arms['.r'], separated)
    assert not contains_volume(Vector((2, 0, 0)), right_arm), '另一条胳膊被误当同侧体积'
    shoulder_points = [Vector(point) for point in [(0, 0, 0), (1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, 2, 0)]]
    shoulder_faces = [(0, 1, 2), (0, 2, 3), (0, 2, 4)]
    shoulder_weights = [(0, 0), (1, 0), (0, 0), (0, 1), (0, 0)]
    shoulder = select_arm_triangles(shoulder_faces, shoulder_points, shoulder_weights, [False, False, True])
    assert shoulder['.l'] == [(0, 2, 4)], '人形显式 arms 的纯 Chest 肩根被权重过滤'
    print('身体体积判定反例通过', flush=True)


# 目录决定资源来源，动作使用身体定义中的正式片段，不生成替代动作。
def verify(options):
    import bpy

    verify_containment_geometry()
    catalog = json.loads(options.catalog.read_text())
    wearables = [item for item in catalog['wearables'] if item['slot'] == 'upper' and not item.get('empty')]
    if options.only:
        missing = set(options.only) - {item['wearable_key'] for item in wearables}
        if missing:
            raise ValueError('unknown upper wearables: ' + ', '.join(sorted(missing)))
        wearables = [item for item in wearables if item['wearable_key'] in options.only]
    directories = [*options.asset_directory, ROOT / 'internal/assets/builtin']
    keys = list(dict.fromkeys([body['model_asset_key'] for body in catalog['characters']]
                             + [item['model_asset_key'] for item in wearables]))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sources, hashes = {}, {}
    for index, key in enumerate(keys):
        path = asset_path(key, directories)
        sources[key] = import_model(bpy, path, str(index))
        hashes[key] = dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    samples = {item['wearable_key']: garment_samples([sources[item['model_asset_key']][0][name] for name in item['nodes']],
                                                    sources[item['model_asset_key']][1]) for item in wearables}
    assert all(samples.values()), '上装没有可检验的手臂外表面'
    actions, animation_sources = {}, {}
    for body in catalog['characters']:
        for motion in ['idle', 'cheer', 'read']:
            definition = body['animations'][motion]
            action_key = definition['asset_key'], definition['clip']
            if action_key in actions:
                continue
            path = asset_path(definition['asset_key'], directories)
            if definition['asset_key'] not in animation_sources:
                previous = set(bpy.data.actions)
                bpy.ops.import_scene.gltf(filepath=str(path))
                animation_sources[definition['asset_key']] = set(bpy.data.actions) - previous
            actions[action_key] = next(action for action in animation_sources[definition['asset_key']]
                                       if action.name.partition('|')[-1] == definition['clip']
                                       or action.name == definition['clip'])
            hashes[definition['asset_key']] = dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    records, references = [], []
    for body in catalog['characters']:
        meshes, body_rig = sources[body['model_asset_key']]
        body_objects = [meshes[name] for name in dict.fromkeys(body['body_regions']['torso']
                                                            + body['body_regions']['arms'] + body['fixed_nodes'])]
        arm_objects = {meshes[name] for name in body['body_regions']['arms'] + body['fixed_nodes']}
        for motion, frame in POSES:
            for _, rig in sources.values():
                rig.animation_data_clear()
                rig.data.pose_position = 'REST' if motion == 'rest' else 'POSE'
                if motion != 'rest':
                    definition = body['animations'][motion]
                    action = actions[definition['asset_key'], definition['clip']]
                    rig.animation_data_create()
                    rig.animation_data.action = action
                    if action.slots:
                        rig.animation_data.action_slot = action.slots[0]
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            surface = body_surface(bpy, body_objects, arm_objects)
            references.append(dict(body_key=body['character_key'], motion=motion, frame=frame,
                                   components=surface['counts']))
            if motion == 'rest':
                bones = {side: [body_rig.matrix_world @ body_rig.data.bones[name + side].head_local for name in ARM_BONES]
                         + [body_rig.matrix_world @ body_rig.data.bones['hand' + side].tail_local] for side in ['.l', '.r']}
            else:
                bones = {side: [body_rig.matrix_world @ body_rig.pose.bones[name + side].head for name in ARM_BONES]
                         + [body_rig.matrix_world @ body_rig.pose.bones['hand' + side].tail] for side in ['.l', '.r']}
            for item in wearables:
                regions = measure_samples(bpy, samples[item['wearable_key']], surface, bones)
                records.append(dict(wearable_key=item['wearable_key'], body_key=body['character_key'],
                                    motion=motion, frame=frame, regions=regions,
                                    passed=all(stats['passed'] for stats in regions.values())))
            print('手臂姿势检查完成', body['character_key'], motion, frame, flush=True)
    failed = [record for record in records if not record['passed']]
    report = dict(complete=not failed, geometry_domain=GEOMETRY_DOMAIN,
                  sample_method='Exterior triangles; seven probes; garment self-occlusion excluded; complete same-arm bone components or explicit human arm/hand regions; virtual caps used only for containment by absolute winding > 0.5; rest-area weighted estimates.',
                  catalog=dict(path=str(options.catalog), sha256=hashlib.sha256(options.catalog.read_bytes()).hexdigest()),
                  thresholds=dict(penetration=PENETRATION_TOLERANCE, buried_area_ratio=MAXIMUM_BURIED_AREA_RATIO,
                                  maximum_penetration=MAXIMUM_PENETRATION), assets=hashes, records=records, body_references=references,
                  summary=dict(wearables=len(wearables), bodies=len(catalog['characters']), poses=len(POSES),
                               combinations=len(records), failed=len(failed)))
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    for record in failed[:20]:
        regions = {name: dict(buried_area_ratio=round(stats['buried_area_ratio'], 4), maximum_depth=round(stats['maximum_depth'], 5))
                   for name, stats in record['regions'].items() if not stats['passed']}
        print('手臂外表面被身体遮住', record['wearable_key'], record['body_key'], record['motion'], record['frame'], regions, flush=True)
    assert not failed, f'{len(failed)}/{len(records)} 个上装、身体与姿势组合未通过；完整证据：{options.report}'
    print('全部手臂外表面检查通过', len(records), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'internal/character/character-catalog.json')
    parser.add_argument('--asset-directory', type=Path, action='append', default=[])
    parser.add_argument('--only', nargs='+')
    parser.add_argument('--report', type=Path, default=Path('/tmp/modular-character-arm-fit-report.json'))
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    verify(parser.parse_args(arguments))
