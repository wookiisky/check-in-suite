"""离线收拢基础骷髅腰部；同一空间场保持分区接缝与原蒙皮。"""
from typing import TypedDict


class SkeletonWaistSettings(TypedDict):
    """配方显式声明的腰部横截面与平滑过渡范围。"""
    scale_xy: list[float]  # 最强处的左右和前后比例；高度不变。
    height_band: list[float]  # 下缘、完全生效下缘、完全生效上缘、上缘。


# 平滑过渡两端导数为零，不在高度边界制造新的折环。
def smoothstep(value):
    value=max(0.0,min(1.0,value))
    return value*value*(3-2*value)


# torso和legs同时传入；相同源坐标使用同一场，人工球、大腿和源小腿不变。
def fit_skeleton_waist(objects, rig, settings: SkeletonWaistSettings):
    from mathutils import Vector

    lower,full_lower,full_upper,upper=settings['height_band']
    scale_x,scale_y=settings['scale_xy']
    inverse_rig=rig.matrix_world.inverted()
    records=[]
    for obj in objects:
        original_vertices={index for face in obj.data.polygons
                           if obj.data.materials[face.material_index].name.split('.')[0]=='skeleton'
                           for index in face.vertices}
        into_rig=inverse_rig@obj.matrix_world
        into_object=into_rig.inverted()
        changed=[]
        maximum=0.0
        for index in sorted(original_vertices):
            vertex=obj.data.vertices[index]
            point=into_rig@vertex.co
            if not lower<point.z<upper:
                continue
            strength=min(smoothstep((point.z-lower)/(full_lower-lower)),
                         smoothstep((upper-point.z)/(upper-full_upper)))
            transformed=Vector((point.x*(1+(scale_x-1)*strength),
                                point.y*(1+(scale_y-1)*strength),point.z))
            coordinate=into_object@transformed
            delta=(coordinate-vertex.co).length
            if delta>.00000001:
                vertex.co=coordinate
                changed.append(index)
                maximum=max(maximum,delta)
        # 仅调整位置场，保留作者的块面/平滑自定义法线；最终GLB另做实际光照图复查。
        obj.data.update()
        records.append({'object':obj.name,'changed_vertices':changed,'maximum_displacement':maximum})
    return {'settings':settings,'objects':records,'preserved':'Faces, UV, materials, weights, Z coordinates, skeleton and Skeleton_Bone additions.'}
