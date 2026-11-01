"""整理已经验收的首批模型；这不是通用素材生成或自动服装适配管线。"""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / 'internal/assets/builtin'
P0 = ROOT / 'web/public/models/p0'
BUILDING_FILES = {
    'camp-wall-v1': 'wall.glb',
    'camp-doorway-v1': 'wall-doorway-square.glb',
    'camp-floor-v1': 'floor.glb',
    'camp-roof-v1': 'roof-flat-center.glb',
}


# 首批 Kenney GLB 的外链 PNG 写入同一容器，运行时无需额外文件路由。
def embed_building_texture(source, target):
    data = source.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    binary = bytearray(data[28 + length:])
    for image in document.get('images', []):
        if 'uri' not in image:
            continue
        texture = (source.parent / image.pop('uri')).read_bytes()
        while len(binary) % 4:
            binary.append(0)
        image['bufferView'] = len(document.setdefault('bufferViews', []))
        image['mimeType'] = 'image/png'
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(texture)})
        binary.extend(texture)
    document['buffers'][0]['byteLength'] = len(binary)
    while len(binary) % 4:
        binary.append(0)
    content = json.dumps(document, separators=(',', ':')).encode()
    content += b' ' * (-len(content) % 4)
    total = 12 + 8 + len(content) + 8 + len(binary)
    target.write_bytes(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(content), 0x4E4F534A) + content + struct.pack('<II', len(binary), 0x004E4942) + binary)


# 使用交付 GLB 的实际网格渲染透明图；不读取未交付的 Blender 草稿。
def render_thumbnails():
    import bpy
    from mathutils import Vector
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(BUILTIN / 'character-medium-v1.glb'))
    manifest = json.loads((ROOT / 'internal/character/character-catalog.json').read_text())
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    idle = next(action for action in bpy.data.actions if action.name == 'Idle')
    rig.animation_data.action = idle
    rig.animation_data.action_slot = idle.slots[0]
    scene = bpy.context.scene
    scene.frame_set(1)
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.world.color = (.35, .35, .35)
    camera_data = bpy.data.cameras.new('ThumbnailCamera')
    camera_data.type = 'ORTHO'
    camera = bpy.data.objects.new('ThumbnailCamera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for position, energy, size in [((4, -6, 7), 700, 6), ((-4, -2, 3), 400, 5)]:
        light_data = bpy.data.lights.new('ThumbnailLight', 'AREA')
        light_data.energy = energy
        light_data.size = size
        light = bpy.data.objects.new('ThumbnailLight', light_data)
        scene.collection.objects.link(light)
        light.location = position
        light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()
    for wearable in manifest['wearables']:
        visible = set(wearable['nodes'])
        if wearable['slot'] == 'hair':
            visible.update(['body_head', 'body_scalp'])
        for mesh in meshes:
            mesh.hide_render = mesh.name not in visible
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        corners = [obj.matrix_world @ Vector(corner) for obj in meshes if not obj.hide_render for corner in obj.evaluated_get(graph).bound_box]
        lower = Vector(tuple(min(point[index] for point in corners) for index in range(3)))
        upper = Vector(tuple(max(point[index] for point in corners) for index in range(3)))
        center = (lower + upper) / 2
        camera.location = center + Vector((3, -7, 3.2))
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        rotation = camera.rotation_euler.to_matrix()
        horizontal, vertical = rotation.col[0], rotation.col[1]
        width = max((point - center).dot(horizontal) for point in corners) - min((point - center).dot(horizontal) for point in corners)
        height = max((point - center).dot(vertical) for point in corners) - min((point - center).dot(vertical) for point in corners)
        camera_data.ortho_scale = max(width, height) * 1.18
        scene.render.filepath = str(BUILTIN / (wearable['thumbnail_asset_key'] + '.png'))
        bpy.ops.render.render(write_still=True)


# 文件复制与纹理内嵌不依赖 Blender；需要重绘缩略图时显式传入 Blender。
def prepare(blender):
    shutil.copyfile(P0 / 'character/modular.glb', BUILTIN / 'character-medium-v1.glb')
    shutil.copyfile(P0 / 'animations/exercise.glb', BUILTIN / 'character-exercise-v1.glb')
    for key, filename in BUILDING_FILES.items():
        embed_building_texture(P0 / 'kenney' / filename, BUILTIN / (key + '.glb'))
    if blender:
        subprocess.run([blender, '--background', '--factory-startup', '--python', str(Path(__file__).resolve()), '--', '--render'], check=True, cwd=ROOT)


if __name__ == '__main__':
    if '--render' in sys.argv:
        render_thumbnails()
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--blender', help='显式指定 Blender 可执行文件以重绘缩略图')
        options = parser.parse_args()
        prepare(options.blender)
