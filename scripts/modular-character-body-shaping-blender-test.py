"""用真实标准身体验证低面数裸身、分区接缝、绑定与握姿。"""
import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# 实际制作配方也进入几何验收，调参不能绕过真实绑定检查。
def production_profile():
    return json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())['human_body_shape']


# 位置键合并分区重复点，接缝两侧必须使用完全相同的权重。
def vertex_record(obj, vertex, evaluated=False):
    point = obj.matrix_world @ vertex.co
    key = tuple(round(value, 6) for value in point)
    weights = {obj.vertex_groups[g.group].name: round(g.weight, 6) for g in vertex.groups}
    return key, weights


# 验证实际蒙皮后没有裂缝，不只比较未变形坐标。
def verify():
    import bpy
    from mathutils import Vector
    from collections import Counter
    config = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / config['canonical_input']['path']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    objects = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    unchanged = {name: [tuple(v.co) for v in obj.data.vertices] for name, obj in objects.items() if name not in ['body_torso', 'body_arms', 'body_hands']}
    matrices = {bone.name: bone.matrix_local.copy() for bone in rig.data.bones}
    spec = importlib.util.spec_from_file_location('body_shaping', ROOT / 'scripts/modular-character-body-shaping.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    profile = production_profile()
    invalid = {**profile['arm_skinning_reference'], 'sha256': '0' * 64}
    before_reference = set(bpy.data.objects)
    try:
        module.load_arm_skinning_reference(invalid)
        raise AssertionError('错误蒙皮参考没有被拒绝')
    except ValueError:
        pass
    assert set(bpy.data.objects) == before_reference, '错误参考改变了当前场景'
    reference = module.load_arm_skinning_reference(profile['arm_skinning_reference'])
    sampled = reference.sample(Vector((.6, 0, 1.1)))
    assert sampled == reference.sample(Vector((.6, .1, 1.2))), '同截面不同角度取得了不同蒙皮'
    assert reference.sample(Vector((.72, -.1, 1.02)), hand=True) == {'hand.l': 1.0}, '折回的握指重新绑到手腕'
    evidence = module.apply_human_body(objects, rig, profile)
    shaped = [objects[name] for name in ['body_torso', 'body_arms', 'body_hands']]
    assert sum(len(obj.data.polygons) for obj in shaped) < 700, '裸身细分过密'
    assert all(matrices[b.name] == b.matrix_local for b in rig.data.bones), '标准骨架被修改'
    assert all(values == [tuple(v.co) for v in objects[name].data.vertices] for name, values in unchanged.items()), '范围外身体或衣物被修改'
    records = {}
    edges = Counter()
    for obj in shaped:
        for vertex in obj.data.vertices:
            key, weights = vertex_record(obj, vertex)
            assert weights and abs(sum(weights.values()) - 1) < .00001, '存在无权重或未归一化顶点'
            assert all(name in rig.data.bones for name in weights), '绑定到不存在的骨骼'
            if key in records:
                assert records[key] == weights, '身体分区接缝的蒙皮不相同'
            records[key] = weights
        for face in obj.data.polygons:
            assert face.area > 1e-9, '裸身出现退化面'
            keys = [vertex_record(obj, obj.data.vertices[index])[0] for index in face.vertices]
            for a, b in zip(keys, keys[1:] + keys[:1]):
                edges[tuple(sorted([a, b]))] += 1
    waist = {vertex_record(objects['body_legs'], v)[0]: vertex_record(objects['body_legs'], v)[1] for v in objects['body_legs'].data.vertices if abs(v.co.z - .72) < 1e-5}
    boundary = {point for edge, count in edges.items() if count == 1 for point in edge}
    assert boundary == waist.keys(), '肩、肘、腕掌或拇指存在未连接的洞'
    assert all(records[key] == weights for key, weights in waist.items()), '原腰线坐标或权重没有接上'
    assert all(count in [1, 2] for count in edges.values()), '身体存在重叠拓扑'
    # 镜像肩部需要相同的连接边，八点孔顺序错误仍可能闭合却发生扭转。
    connections = set(edges)
    for edge in connections:
        if all(.18 < point[0] < .4 and point[2] > .95 for point in edge):
            mirrored = tuple(sorted([(-point[0], point[1], point[2]) for point in edge]))
            assert any(max((Vector(a) - Vector(b)).length for a, b in zip(mirrored, other)) < 1e-5 for other in connections), '左右肩臂拓扑不是镜像，可能存在扭转'
    # 源拳形掌指保持同一掌骨，不能再把折回的裸指绑定到腕骨。
    hands = objects['body_hands']
    assert evidence['hand_surface']['source_faces'] > 0, '没有采用真实裸手表面'
    for vertex in hands.data.vertices:
        _, weights = vertex_record(hands, vertex)
        expected = 'hand.l' if vertex.co.x > 0 else 'hand.r'
        assert weights == {expected: 1.0}, '真实掌指没有保持抓握形'
    rig.data.pose_position = 'POSE'
    for name in ['upperarm.l', 'upperarm.r', 'lowerarm.l', 'lowerarm.r', 'wrist.l', 'wrist.r', 'hand.l', 'hand.r']:
        bone = rig.pose.bones[name]
        bone.rotation_mode = 'XYZ'
        bone.rotation_euler.y = .65 if name.endswith('.l') else -.65
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    posed = {}
    for obj in shaped:
        evaluated = obj.evaluated_get(graph)
        for original, vertex in zip(obj.data.vertices, evaluated.data.vertices):
            key = vertex_record(obj, original)[0]
            point = evaluated.matrix_world @ vertex.co
            if key in posed:
                assert (point - posed[key]).length < 1e-6, '动作时身体分区开裂'
            posed[key] = point
    assert max((point - Vector(key)).length for key, point in posed.items()) > .08, '真实骨骼变形没有执行'
    # 同一套真实交付动作逐帧检查，而非只检查自设关节旋转。
    catalog = json.loads((ROOT / 'internal/character/character-catalog.json').read_text())
    human = next(body for body in catalog['characters'] if body['character_key'] == 'kaykit-medium-v1')
    for semantic, frames in [('idle', [13]), ('cheer', [11, 21, 31]), ('read', [24, 48, 72])]:
        definition = human['animations'][semantic]
        before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / 'internal/assets/builtin' / (definition['asset_key'] + '.glb')))
        action = next(action for action in set(bpy.data.actions) - before_actions if action.name.split('|')[-1].partition('.')[0] == definition['clip'])
        for added in set(bpy.data.objects) - before_objects:
            bpy.data.objects.remove(added, do_unlink=True)
        for bone in rig.pose.bones:
            bone.rotation_mode = 'QUATERNION'
            bone.matrix_basis.identity()
        rig.animation_data_create()
        rig.animation_data.action = action
        if action.slots:
            rig.animation_data.action_slot = action.slots[0]
        for frame in frames:
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            graph = bpy.context.evaluated_depsgraph_get()
            hand = objects['body_hands']
            deformed = hand.evaluated_get(graph).data
            stretch = [(deformed.vertices[e.vertices[0]].co - deformed.vertices[e.vertices[1]].co).length / (hand.data.vertices[e.vertices[0]].co - hand.data.vertices[e.vertices[1]].co).length for e in hand.data.edges]
            print('手部局部拉伸', semantic, frame, max(stretch), flush=True)
            assert max(stretch) < 2, f'{semantic}帧{frame}手部局部边被拉成长刺'
            arms = objects['body_arms']
            arm_mesh = arms.evaluated_get(graph).data
            arm_stretch = [(arm_mesh.vertices[e.vertices[0]].co - arm_mesh.vertices[e.vertices[1]].co).length / (arms.data.vertices[e.vertices[0]].co - arms.data.vertices[e.vertices[1]].co).length for e in arms.data.edges]
            print('手臂局部拉伸', semantic, frame, max(arm_stretch), flush=True)
            assert max(arm_stretch) < 2, f'{semantic}帧{frame}手臂过渡被拉成长片'
            # 两个圆润闭合端在实际腕关节处保留共同体积，不依赖轮廓看起来相接。
            from mathutils.bvhtree import BVHTree
            arm_tree = BVHTree.FromPolygons([v.co for v in arm_mesh.vertices], [tuple(f.vertices) for f in arm_mesh.polygons])
            hand_tree = BVHTree.FromPolygons([v.co for v in deformed.vertices], [tuple(f.vertices) for f in deformed.polygons])
            for side in ['l', 'r']:
                hand_bone = rig.data.bones['hand.' + side]
                forearm_transform = rig.pose.bones['lowerarm.' + side].matrix @ rig.data.bones['lowerarm.' + side].matrix_local.inverted()
                center = ((forearm_transform @ hand_bone.head_local) + rig.pose.bones['hand.' + side].head) / 2
                radius = min(profile['wrist_joint']['forearm_cap_sections'][0][1:]) / 4
                probes = [center + Vector(offset) * radius for offset in [(0,0,0),(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
                for tree in [arm_tree, hand_tree]:
                    for point in probes:
                        hit, normal, _, _ = tree.find_nearest(point)
                        assert (point - hit).dot(normal) < -1e-5, f'{semantic}帧{frame}腕关节失去重叠体积'

            for face in hand.data.polygons:
                side = 'l' if face.center.x >= 0 else 'r'
                transform = rig.pose.bones['hand.' + side].matrix @ rig.data.bones['hand.' + side].matrix_local.inverted()
                expected = (transform.to_3x3() @ face.normal).normalized()
                actual = deformed.polygons[face.index]
                assert actual.area > face.area * .25 and actual.normal.dot(expected) > .25, f'{semantic}帧{frame}手部出现折叠或翻面'

            posed = {}
            for obj in shaped:
                evaluated = obj.evaluated_get(graph)
                for original, vertex in zip(obj.data.vertices, evaluated.data.vertices):
                    key = vertex_record(obj, original)[0]
                    point = evaluated.matrix_world @ vertex.co
                    if key in posed:
                        assert (point - posed[key]).length < 1e-6, f'{semantic}帧{frame}身体分区开裂'
                    posed[key] = point
    rig.animation_data_clear()
    # 实际glTF往返后，拆开的节点仍需保留统一外观及肩腕法线。
    rig.data.pose_position = 'REST'
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for obj in shaped:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    with tempfile.TemporaryDirectory(prefix='bare-human-shape-') as directory:
        path = Path(directory) / 'body.glb'
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_def_bones=False)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
    normals = {}
    assert sampled == reference.sample(Vector((.6, 0, 1.1))), '场景重置破坏了独立蒙皮参考'
    for obj in [item for item in bpy.data.objects if item.type == 'MESH' and item.name in ['body_torso', 'body_arms', 'body_hands']]:
        assert obj.data.materials, 'GLB重入丢失皮肤材质: ' + obj.name
        shader = obj.data.materials[0].node_tree.nodes.get('Principled BSDF')
        assert not shader.inputs['Base Color'].is_linked, '皮肤仍连接衣物纹理'
        assert all(abs(a - b) < 1e-5 for a, b in zip(shader.inputs['Base Color'].default_value, production_profile()['skin_color'])), '皮肤颜色没有保留'
        for loop in obj.data.loops:
            key = vertex_record(obj, obj.data.vertices[loop.vertex_index])[0]
            normal = obj.data.corner_normals[loop.index].vector
            if key in normals:
                assert normal.dot(normals[key]) > .9999, 'GLB重入后肩或腕分区出现法线接缝'
            normals[key] = normal.copy()
    print('裸身连续与真实蒙皮检查通过', json.dumps(evidence, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    verify()
