"""将本次 Mixamo 开合跳离线烘焙到 KayKit Rogue 骨架；不提供运行时重定向。"""
import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# 本次源动作与目标骨架已经人工核对；肩、颈和手指不扩展首期骨架。
BONE_MAP = {
    'hips': 'Hips', 'spine': 'Spine1', 'chest': 'Spine2', 'head': 'Head',
    'upperarm.l': 'LeftArm', 'lowerarm.l': 'LeftForeArm', 'wrist.l': 'LeftHand', 'hand.l': 'LeftHand',
    'upperarm.r': 'RightArm', 'lowerarm.r': 'RightForeArm', 'wrist.r': 'RightHand', 'hand.r': 'RightHand',
    'upperleg.l': 'LeftUpLeg', 'lowerleg.l': 'LeftLeg', 'foot.l': 'LeftFoot', 'toes.l': 'LeftToeBase',
    'upperleg.r': 'RightUpLeg', 'lowerleg.r': 'RightLeg', 'foot.r': 'RightFoot', 'toes.r': 'RightToeBase',
}

# 源文件只留在本地，输出只包含项目所需的目标骨架和动作。
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '.local/3d-sources/mixamo/jumping-jacks.fbx'
TARGET = ROOT / '.local/3d-sources/kaykit-adventurers/Characters/gltf/Rogue.glb'
OUTPUT = ROOT / 'web/public/models/p0/animations'
WORK = ROOT / '.local/3d-sources/mixamo'


# 使用骨骼的世界 rest 对齐单位和前向，避免仅凭骨骼名称拷贝四元数。
def world_rotation(armature, matrix):
    return (armature.matrix_world @ matrix).to_quaternion().normalized()


# 全局姿势先保持目标肢段长度，再应用源关节的世界旋转变化。
def bake_action(source, target):
    scene = bpy.context.scene
    source_action = source.animation_data.action
    first, last = (int(value) for value in source_action.frame_range)
    source_rest = {name: world_rotation(source, source.data.bones['mixamorig:' + mapped].matrix_local) for name, mapped in BONE_MAP.items()}
    target_rest = {bone.name: bone.matrix_local.copy() for bone in target.data.bones}
    target_world_inverse = target.matrix_world.to_quaternion().inverted()
    target_hips = target.data.bones['hips'].head_local.z
    source_hips = (source.matrix_world @ source.data.bones['mixamorig:Hips'].head_local).z
    source_leg = ((source.matrix_world @ source.data.bones['mixamorig:LeftUpLeg'].head_local) - (source.matrix_world @ source.data.bones['mixamorig:LeftFoot'].head_local)).length
    target_leg = (target.data.bones['upperleg.l'].head_local - target.data.bones['foot.l'].head_local).length
    height_ratio = target_leg / source_leg
    target.animation_data_clear()
    target.animation_data_create()
    action = bpy.data.actions.new('Exercise')
    target.animation_data.action = action
    ordered = sorted(target.pose.bones, key=lambda bone: len(bone.parent_recursive))
    for bone in ordered:
        bone.rotation_mode = 'QUATERNION'
    for frame in range(first, last + 1):
        scene.frame_set(frame)
        evaluated = source.evaluated_get(bpy.context.evaluated_depsgraph_get())
        source_pose_hips = (source.matrix_world @ evaluated.pose.bones['mixamorig:Hips'].matrix).translation.z
        arm_adjustments = {}
        # 未映射的 IK 辅助骨保留 rest；目标 GLB 中不存在运行时约束。
        for pose in ordered:
            rest = target_rest[pose.name]
            parent = pose.parent
            inherited = parent.matrix @ target_rest[parent.name].inverted() @ rest if parent else rest.copy()
            rotation = inherited.to_quaternion()
            if pose.name in BONE_MAP:
                source_pose = evaluated.pose.bones['mixamorig:' + BONE_MAP[pose.name]]
                delta = world_rotation(source, source_pose.matrix) @ source_rest[pose.name].inverted()
                rotation = target_world_inverse @ delta @ world_rotation(target, rest)
                # 大头短臂人物不能照搬 Xbot 的过顶握手：限制举臂高度并整体修正同侧手臂。
                if pose.name.startswith('upperarm.'):
                    direction = rotation @ Vector((0, 1, 0))
                    if direction.z > 0.5:
                        side = 1 if pose.name.endswith('.l') else -1
                        safe_direction = Vector((side * math.sqrt(0.75), 0, 0.5))
                        arm_adjustments[pose.name[-1]] = direction.rotation_difference(safe_direction)
                if pose.name.startswith(('upperarm.', 'lowerarm.', 'wrist.', 'hand.')):
                    adjustment = arm_adjustments.get(pose.name[-1])
                    if adjustment:
                        rotation = adjustment @ rotation
                if pose.name.startswith('lowerarm.'):
                    direction = rotation @ Vector((0, 1, 0))
                    if direction.z > 0.5:
                        side = 1 if pose.name.endswith('.l') else -1
                        correction = direction.rotation_difference(Vector((side * math.sqrt(0.75), 0, 0.5)))
                        rotation = correction @ rotation
                        prior = arm_adjustments.get(pose.name[-1])
                        arm_adjustments[pose.name[-1]] = correction @ prior if prior else correction
            position = inherited.translation.copy()
            if pose.name == 'hips':
                position = Vector((0, 0, target_hips + (source_pose_hips - source_hips) * height_ratio))
            pose.matrix = Matrix.LocRotScale(position, rotation, Vector((1, 1, 1)))
            pose.keyframe_insert('rotation_quaternion', frame=frame)
            if pose.name == 'hips':
                pose.keyframe_insert('location', frame=frame)
            # 子骨求局部姿势时必须使用刚更新的父骨，不能等待整帧末尾求值。
            bpy.context.view_layer.update()
    scene.frame_start, scene.frame_end = first, last
    scene.render.fps = 30
    scene.frame_set(first)
    return target_rest, {'frames': last - first + 1, 'fps': 30, 'vertical_scale': height_ratio}


# 导出前主动检查髋部无水平移动，手臂和脚的旋转确实随源采样变化。
def verify_bake(target, first, last, rest):
    poses = {}
    for frame in range(first, last + 1):
        bpy.context.scene.frame_set(frame)
        hips = target.pose.bones['hips'].matrix.translation
        assert abs(hips.x) < 1e-5 and abs(hips.y) < 1e-5, '髋部包含水平根位移'
        for name in ['upperarm.l', 'upperarm.r', 'foot.l', 'foot.r']:
            poses.setdefault(name, []).append(target.pose.bones[name].matrix.to_quaternion())
    for name, samples in poses.items():
        assert any(samples[0].rotation_difference(sample).angle > 0.02 for sample in samples), name + ' 没有运动'
    for bone in target.data.bones:
        assert bone.matrix_local == rest[bone.name], '目标 rest 发生变化'


# 只输出目标骨架；Mixamo 原人物和原始 FBX 不进入可公开下载的资源。
def main():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=str(SOURCE))
    source = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
    source.name = 'MixamoRig'
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(TARGET))
    target = next(obj for obj in bpy.context.scene.objects if obj not in before and obj.type == 'ARMATURE')
    target.name = 'Rig'
    rest, measurements = bake_action(source, target)
    verify_bake(target, bpy.context.scene.frame_start, bpy.context.scene.frame_end, rest)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'jumping-jacks-retarget.blend'))
    bpy.ops.object.select_all(action='DESELECT')
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT / 'exercise.glb'), export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIVE_ACTIONS', export_force_sampling=True,
        export_nla_strips_merged_animation_name='Exercise',
        export_anim_slide_to_zero=True,
        export_frame_range=True, export_skins=False, export_yup=True,
        export_anim_single_armature=True, export_reset_pose_bones=True,
    )
    metadata = {
        'id': 'p0-exercise', 'animation': 'Exercise', 'file': 'exercise.glb',
        'target_rig': 'KayKit Adventurers 1.0 Rogue original Rig',
        'target_source': {'url': 'https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0',
                          'revision': '672074b73ba276876a19e8816ecdc5241817ab47', 'license': 'CC0-1.0',
                          'sha256': hashlib.sha256(TARGET.read_bytes()).hexdigest()},
        'source': {'provider': 'Adobe Mixamo', 'url': 'https://www.mixamo.com/', 'animation': 'Jumping Jacks', 'character': 'X Bot',
                   'sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                   'terms': 'https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html'},
        'rights': 'Mixamo 项目使用条款；不是 CC0；不分发原始 FBX 或 X Bot 模型',
        'processing': 'Blender 离线 rest 对齐与逐帧烘焙，保持 Rogue 骨架 rest，不保留水平位移，仅按腿长比例缩放竖向髋部移动；为大头短臂体型将上臂和前臂的过顶举臂改为最高水平以上30度，手继承同侧修正',
        'bone_map': BONE_MAP, 'measurements': measurements,
        'sha256': hashlib.sha256((OUTPUT / 'exercise.glb').read_bytes()).hexdigest(),
    }
    (OUTPUT / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print('动作离线转换完成', json.dumps(measurements))


if __name__ == '__main__':
    main()
