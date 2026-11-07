"""只修人工股骨上环的蒙皮，使髋球与股骨保持标准蒙皮连接。"""

from pathlib import Path
import importlib.util
from typing import Literal, TypedDict


class SkeletonHipSettings(TypedDict):
    """人工上环跟随髋球；原作者网格与人工下环保持原绑定。"""

    upper_ring_bone: Literal["hips"]  # 与现有人工髋球一致的标准骨名。


# glTF的UV/法线重复点按位置归并，选择仍依据人工材质与实际腿骨蒙皮。
def bind_skeleton_hip_joints(legs, rig, settings: SkeletonHipSettings):
    path = Path(__file__).with_name("modular-character-clothing-fit.py")
    spec = importlib.util.spec_from_file_location("_hip_source_components", path)
    components = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(components)
    target = settings["upper_ring_bone"]
    rig.data.bones[target]
    selected = []
    for component in components.mesh_components(legs):
        bones = {
            legs.vertex_groups[group.group].name
            for index in component["vertices"]
            for group in legs.data.vertices[index].groups
            if group.weight > 1e-5
        }
        if component["materials"] != ["Skeleton_Bone"] or bones not in [
            {"upperleg.l"},
            {"upperleg.r"},
        ]:
            continue
        maximum = component["bounds"][2][1]
        ring = [
            index
            for index in component["vertices"]
            if abs((legs.matrix_world @ legs.data.vertices[index].co).z - maximum)
            < 1e-5
        ]
        positions = {
            tuple(
                round(value, 5)
                for value in legs.matrix_world @ legs.data.vertices[index].co
            )
            for index in ring
        }
        selected.append(
            {
                "side": "l" if "upperleg.l" in bones else "r",
                "vertex_indices": ring,
                "unique_positions": len(positions),
                "height": maximum,
                "component_faces": len(component["faces"]),
            }
        )
    if len(selected) != 2:
        raise ValueError("未唯一找到左右人工股骨组件")
    for component in selected:
        for index in component["vertex_indices"]:
            # 只修改这个人工环；所有原腿、下环、位置、UV及面均不写入。
            for group in list(legs.data.vertices[index].groups):
                legs.vertex_groups[group.group].remove([index])
            hips = legs.vertex_groups.get(target) or legs.vertex_groups.new(name=target)
            hips.add([index], 1.0, "REPLACE")
    return {
        "method": "artificial-femur-upper-ring-follows-hips",
        "settings": settings,
        "selection_height_tolerance": 1e-5,
        "components": selected,
        "preserved": "All rest positions, topology, UV, normals, skeleton and every vertex weight outside these artificial upper rings.",
    }
