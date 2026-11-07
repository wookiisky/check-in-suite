"""离线延长新增大腿的下端，保留原腿骨、骨架、UV和权重。"""
import importlib.util
from pathlib import Path


# 只识别本项目新增且完全绑定大腿骨的骨色部件，源腿骨保持原样。
def close_skeleton_knees(obj, rig, overlap_fraction=.2):
    specification = importlib.util.spec_from_file_location('skeleton_knee_components', Path(__file__).with_name('modular-character-clothing-fit.py'))
    fitting = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(fitting)
    components = fitting.mesh_components(obj)
    reports = []
    for component in components:
        side = '.l' if component['center'].x>0 else '.r'
        groups = {obj.vertex_groups[group.group].name for i in component['vertices'] for group in obj.data.vertices[i].groups if group.weight>.00001}
        if component['materials']!=['Skeleton_Bone'] or groups!={'upperleg'+side}:
            continue
        source = [item for item in components if item['materials']!=['Skeleton_Bone'] and item['center'].x*component['center'].x>0
                  and any(obj.vertex_groups[group.group].name=='lowerleg'+side for i in item['vertices'] for group in obj.data.vertices[i].groups if group.weight>.00001)]
        if len(source)!=1:
            raise ValueError('新增大腿必须对应一块真实源腿骨: '+side)
        lower_bone = rig.data.bones['lowerleg'+side]
        lower_length = (rig.matrix_world@lower_bone.tail_local-rig.matrix_world@lower_bone.head_local).length
        source_top = max((obj.matrix_world@obj.data.vertices[i].co).z for i in source[0]['vertices'])
        bottom = min((obj.matrix_world@obj.data.vertices[i].co).z for i in component['vertices'])
        target = source_top-overlap_fraction*lower_length
        if target>bottom+.00001:
            raise ValueError('膝部修复不能缩短已有大腿: '+side)
        target = min(bottom, target)
        inverse = obj.matrix_world.inverted()
        moved = []
        for index in component['vertices']:
            point = obj.matrix_world@obj.data.vertices[index].co
            if abs(point.z-bottom)<.00001:
                point.z = target
                obj.data.vertices[index].co = inverse@point
                moved.append(index)
        reports.append({'side':side,'method':'extend-generated-thigh-lower-ring','bottom_before':bottom,'bottom_after':target,
                        'source_top':source_top,'overlap':source_top-target,'moved_vertices':len(moved),'weights_changed':False})
    if len(reports)!=2:
        raise ValueError('没有找到两侧新增大腿')
    obj.data.update()
    return reports
