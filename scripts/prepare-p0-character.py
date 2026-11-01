"""用 Blender 加工首件 KayKit 四槽样片；固定源资产和切面，不提供通用生成管线。"""
import json
import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.local/3d-sources/kaykit-adventurers/Characters/gltf'
OUTPUT = ROOT / 'web/public/models/p0/character'
WORK = ROOT / '.local/3d-sources/character-work'
CLIPS = ['Idle', 'Walking_A', 'Running_A', 'Sit_Chair_Idle', 'Cheer']
WAIST = 0.72
ANKLE = 0.23
WRIST = 0.76
SCALE = 1.8 / 2.186978340148926
OUTPUT.mkdir(parents=True, exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)


# 导入时记录对象身份，避免第二个人物的 Blender 自动后缀影响部件选择。
def import_character(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE / (name + '.glb')))
    imported = set(bpy.data.objects) - before
    rig = next(obj for obj in imported if obj.type == 'ARMATURE')
    parts = {obj.name.split('.')[0]: obj for obj in imported if obj.type == 'MESH' and obj.name.startswith(name + '_')}
    return rig, parts, imported


# 复制网格及顶点组，所有新部件统一绑定最终 Rogue 骨架。
def copy_part(source, name):
    result = source.copy()
    result.data = source.data.copy()
    result.name = name
    bpy.context.collection.objects.link(result)
    result.parent = rig
    for modifier in result.modifiers:
        if modifier.type == 'ARMATURE':
            modifier.object = rig
    return result


# Blender 导入器翻转 glTF 的 V 坐标；这里只按已检查的源纹理单元选面。
def head_hair(face, layer):
    uv = sum((loop[layer].uv for loop in face.loops), Vector((0, 0))) / len(face.loops)
    return 0.125 <= uv.x < 0.25 and uv.y > 0.75


# 删除未选中的面并保留蒙皮属性；不靠运行时颜色判断身体和衣服。
def select_faces(source, name, predicate):
    result = copy_part(source, name)
    mesh = bmesh.new()
    mesh.from_mesh(result.data)
    layer = mesh.loops.layers.uv.active
    bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if not predicate(face, layer)], context='FACES')
    bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
    mesh.to_mesh(result.data)
    mesh.free()
    return result


# 用真实平面切开并封闭接口；新顶点沿用 Blender 插值后的蒙皮权重。
def clip_part(obj, axis, value, positive):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    normal = Vector((0, 0, 0))
    normal[axis] = 1
    point = normal * value
    cut = bmesh.ops.bisect_plane(mesh, geom=list(mesh.verts) + list(mesh.edges) + list(mesh.faces), plane_co=point, plane_no=normal, dist=0.000001, clear_inner=positive, clear_outer=not positive)
    edges = [item for item in cut['geom_cut'] if isinstance(item, bmesh.types.BMEdge) and item.is_boundary]
    if edges:
        bmesh.ops.holes_fill(mesh, edges=edges, sides=0)
    bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
    mesh.normal_update()
    mesh.to_mesh(obj.data)
    mesh.free()
    return obj


# 腰部和脚踝使用同一截面，替换款式时不会各自保留不同的连接尺寸。
def shape_seam(obj, height, radius_x, radius_y, center_x=0):
    band = 0.075
    for vertex in obj.data.vertices:
        distance = abs(vertex.co.z - height)
        if distance > band:
            continue
        x, y = vertex.co.x - center_x, vertex.co.y
        length = math.hypot(x / radius_x, y / radius_y)
        if length < 0.000001:
            continue
        amount = (1 - distance / band) ** 2
        vertex.co.x = center_x + x * ((1 - amount) + amount / length)
        vertex.co.y = y * ((1 - amount) + amount / length)


# 合并同一穿戴部位的左右部件，仍由同一骨架驱动。
def join_parts(parts, name):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    result = bpy.context.object
    result.name = name
    result.data.name = name + '_mesh'
    return result


# 身体覆盖区使用收紧后的支撑网格，保留原蒙皮并使用统一肤色。
def body_region(parts, name):
    result = join_parts(parts, name)
    result.data.materials.clear()
    result.data.materials.append(skin_material)
    for vertex in result.data.vertices:
        if name == 'body_arms':
            vertex.co.y *= 0.78
            vertex.co.z = 1.1 + (vertex.co.z - 1.1) * 0.8
        elif name in ['body_torso', 'body_legs']:
            vertex.co.x *= 0.82
            vertex.co.y *= 0.82
    return result


# 固定腰线将完整躯干分成上衣与下装，鞋口同理。
def clothing(parts, character, suffix):
    torso = copy_part(parts[character + '_Body'], 'upper_torso_' + suffix)
    shape_seam(torso, WAIST, 0.30, 0.24)
    clip_part(torso, 2, WAIST, True)
    uppers = [torso]
    lowers = []
    shoes = []
    lower = copy_part(parts[character + '_Body'], 'lower_hips_' + suffix)
    shape_seam(lower, WAIST, 0.30, 0.24)
    lowers.append(clip_part(lower, 2, WAIST, False))
    for side, sign in [('Left', 1), ('Right', -1)]:
        arm = copy_part(parts[character + '_Arm' + side], 'upper_arm_' + side + suffix)
        uppers.append(clip_part(arm, 0, sign * WRIST, sign < 0))
        leg = copy_part(parts[character + '_Leg' + side], 'lower_leg_' + side + suffix)
        shape_seam(leg, ANKLE, 0.10, 0.105, sign * 0.17)
        lowers.append(clip_part(leg, 2, ANKLE, True))
        shoe = copy_part(parts[character + '_Leg' + side], 'shoe_' + side + suffix)
        shape_seam(shoe, ANKLE, 0.10, 0.105, sign * 0.17)
        shoes.append(clip_part(shoe, 2, ANKLE, False))
    return [join_parts(uppers, 'upper_' + suffix), join_parts(lowers, 'lower_' + suffix), join_parts(shoes, 'shoes_' + suffix)]


# 补做没有原始裸露网格的头皮，默认发型仍覆盖在这个实际头部表面上。
def create_scalp():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(0, 0, 1.72))
    obj = bpy.context.object
    obj.name = 'body_scalp'
    obj.scale = (0.405, 0.405, 0.405)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.data.materials.append(skin_material)
    obj.parent = rig
    obj.vertex_groups.new(name='head').add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    modifier = obj.modifiers.new(name='Rig', type='ARMATURE')
    modifier.object = rig
    return obj


# 写出前以实际权重、蒙皮和面数检查交付对象，避免空部件或未绑定部件。
def check_parts(objects):
    report = []
    for obj in objects:
        assert len(obj.data.polygons) > 0, obj.name
        assert any(modifier.type == 'ARMATURE' and modifier.object == rig for modifier in obj.modifiers), obj.name
        missing = [vertex.index for vertex in obj.data.vertices if sum(group.weight for group in vertex.groups) < 0.0001]
        assert not missing, (obj.name, missing[:10])
        report.append({'node': obj.name, 'vertices': len(obj.data.vertices), 'faces': len(obj.data.polygons)})
    return report


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
rig, rogue, rogue_sources = import_character('Rogue')
barbarian_rig, barbarian, barbarian_sources = import_character('Barbarian')
assert set(bone.name for bone in rig.data.bones) == set(bone.name for bone in barbarian_rig.data.bones)
assert max(abs(a - b) for bone in rig.data.bones for row_a, row_b in zip(bone.matrix_local, barbarian_rig.data.bones[bone.name].matrix_local) for a, b in zip(row_a, row_b)) < 0.00001

skin_material = bpy.data.materials.new('Unified_Skin')
skin_material.diffuse_color = (0.72, 0.39, 0.21, 1)
skin_material.use_nodes = True
skin_material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.72, 0.39, 0.21, 1)
skin_material.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.8

head = select_faces(rogue['Rogue_Head'], 'body_head', lambda face, uv: not head_hair(face, uv))
hair_rogue = select_faces(rogue['Rogue_Head'], 'hair_rogue', head_hair)
hair_barbarian = select_faces(barbarian['Barbarian_Head'], 'hair_barbarian', head_hair)
rogue_clothes = clothing(rogue, 'Rogue', 'rogue')
barbarian_clothes = clothing(barbarian, 'Barbarian', 'barbarian')

hands = []
body_arms = []
body_legs = []
body_feet = []
for side, sign in [('Left', 1), ('Right', -1)]:
    hand = copy_part(rogue['Rogue_Arm' + side], 'hand_' + side)
    hands.append(clip_part(hand, 0, sign * WRIST, sign > 0))
    arm = copy_part(rogue['Rogue_Arm' + side], 'body_arm_' + side)
    body_arms.append(clip_part(arm, 0, sign * WRIST, sign < 0))
    leg = copy_part(rogue['Rogue_Leg' + side], 'body_leg_' + side)
    body_legs.append(clip_part(leg, 2, ANKLE, True))
    foot = copy_part(rogue['Rogue_Leg' + side], 'body_foot_' + side)
    body_feet.append(clip_part(foot, 2, ANKLE, False))
body_legs.append(clip_part(copy_part(rogue['Rogue_Body'], 'body_hips'), 2, WAIST, False))
torso = clip_part(copy_part(rogue['Rogue_Body'], 'body_torso'), 2, WAIST, True)
regions = [create_scalp(), body_region([torso], 'body_torso'), body_region(body_arms, 'body_arms'), body_region(body_legs, 'body_legs'), body_region(body_feet, 'body_feet')]
hands = join_parts(hands, 'body_hands')
objects = [head, hands, hair_rogue, hair_barbarian] + rogue_clothes + barbarian_clothes + regions

for obj in (rogue_sources | barbarian_sources) - {rig}:
    bpy.data.objects.remove(obj, do_unlink=True)
for track in list(rig.animation_data.nla_tracks):
    if track.name not in CLIPS:
        rig.animation_data.nla_tracks.remove(track)
rig.animation_data.action = None
for track in rig.animation_data.nla_tracks:
    track.mute = False

report = check_parts(objects)
definition = {
    'id': 'p0-kaykit-medium-v1',
    'rig_id': 'kaykit-adventurers-medium-v1',
    'model_url': '/models/p0/character/modular.glb',
    'scale': SCALE,
    'up': '+Y',
    'forward': '+Z',
    'fixed_nodes': ['body_head', 'body_hands'],
    'body_regions': {'scalp': ['body_scalp'], 'torso': ['body_torso'], 'arms': ['body_arms'], 'legs': ['body_legs'], 'feet': ['body_feet']},
    'defaults': {'hair': 'hair-rogue', 'upper': 'upper-rogue', 'lower': 'lower-rogue', 'shoes': 'shoes-rogue'},
    'slots': {slot: [{'id': slot + '-' + variant, 'nodes': [slot + '_' + variant], 'covers': covers} for variant in ['rogue', 'barbarian']] for slot, covers in [('hair', []), ('upper', ['torso', 'arms']), ('lower', ['legs']), ('shoes', ['feet'])]},
    'animations': CLIPS,
    'source': 'KayKit Adventurers 1.0; CC0-1.0; Rogue and Barbarian; revision 672074b73ba276876a19e8816ecdc5241817ab47',
    'changes': ['从原始纹理单元分离头发与眉毛', '按统一腰线、腕线及鞋口切分并封口，保留蒙皮', 'Barbarian 部件统一到 Rogue 骨架', '补做头皮及衣服内部支撑身体，服装覆盖区由显式节点控制', '原始尺寸保持不变，由实例根节点统一缩放'],
    'seams_m': {'waist_y': WAIST, 'ankle_y': ANKLE, 'wrist_abs_x': WRIST},
}
(OUTPUT / 'character.json').write_text(json.dumps(definition, ensure_ascii=False, indent=2) + '\n')
(OUTPUT / 'inspection.json').write_text(json.dumps({'parts': report, 'blender': bpy.app.version_string, 'body_limit': '衣服内部为首件低面数支撑身体；不提供裸露身体或多体型商品。视觉混搭与动作验收需单独完成。'}, ensure_ascii=False, indent=2) + '\n')
(OUTPUT / 'LICENSE.txt').write_text((ROOT / '.local/3d-sources/kaykit-adventurers/LICENSE.txt').read_text())

bpy.ops.object.select_all(action='DESELECT')
for obj in objects + [rig]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'modular.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUTPUT / 'modular.glb'), export_format='GLB', use_selection=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_def_bones=False, export_force_sampling=True)
print('P0_CHARACTER', json.dumps({'bytes': (OUTPUT / 'modular.glb').stat().st_size, 'parts': report}, ensure_ascii=False))
