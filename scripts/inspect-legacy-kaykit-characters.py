"""用 Blender 检查旧版骷髅的真实网格与蒙皮，并保留逐人物渲染证据。"""

import json
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".local/3d-sources/provider-packs/kaykit/kaykit-skeleton-pack/extracted"
OUTPUT = ROOT / ".local/3d-sources/character-inspection/legacy-kaykit"


# 实际世界坐标中的包围盒用于辨别完整身体与散落残骸。
def bounds(obj):
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    return {
        "min": [min(point[axis] for point in points) for axis in range(3)],
        "max": [max(point[axis] for point in points) for axis in range(3)],
    }


# 按同一相机角度渲染，避免只凭文件名判断头饰和残缺几何。
def inspect(path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    entries = []
    for obj in meshes:
        entries.append({
            "name": obj.name,
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "bounds": bounds(obj),
            "materials": [material.name for material in obj.data.materials if material],
            "vertex_groups": [group.name for group in obj.vertex_groups],
        })

    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector([min(point[axis] for point in points) for axis in range(3)])
    high = Vector([max(point[axis] for point in points) for axis in range(3)])
    center = (low + high) / 2
    radius = max(high - low) * 0.7
    bpy.ops.object.camera_add(location=center + Vector((radius * 1.6, -radius * 2.6, radius * 1.2)))
    camera = bpy.context.object
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = radius * 2.4
    scene = bpy.context.scene
    scene.camera = camera
    for location, power, size in [((3, -4, 6), 600, 5), ((-4, -1, 3), 350, 4)]:
        bpy.ops.object.light_add(type="AREA", location=center + Vector(location))
        light = bpy.context.object
        light.data.energy = power
        light.data.shape = "DISK"
        light.data.size = size
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 12
    scene.render.resolution_x = 480
    scene.render.resolution_y = 480
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.world.color = (0.25, 0.25, 0.25)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(OUTPUT / (path.stem + ".png"))
    bpy.ops.render.render(write_still=True)
    return {
        "source_relative_path": str(path.relative_to(SOURCE)),
        "armatures": [obj.name for obj in armatures],
        "meshes": entries,
        "bounds": {"min": list(low), "max": list(high)},
        "render": str(Path(scene.render.filepath).relative_to(ROOT)),
    }


# 证据与工程留在本地，正式角色导入器不依赖此检查脚本。
def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = [inspect(path) for path in sorted((SOURCE / "Models/characters/gltf").glob("*.gltf"))]
    (OUTPUT / "inspection.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
