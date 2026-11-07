"""仅整理首批建筑与动作；人物和穿戴由prepare-modular-characters.py制作。"""
import argparse
import json
import importlib.util
import shutil
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / '.local/asset-pipeline/resources/internal/assets/builtin'
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
    write_immutable(target, struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(content), 0x4E4F534A) + content + struct.pack('<II', len(binary), 0x004E4942) + binary)


# 已发布身份只能重用相同字节，人物目录由新的六槽制作入口管理。
def write_immutable(target, data):
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError('immutable-resource-changed: ' + target.name)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


# 文件复制与纹理内嵌不依赖Blender，也不读取或修改人物目录。
def prepare(output=None):
    destination = output / 'internal/assets/builtin' if output is not None else BUILTIN
    write_immutable(destination/'character-exercise-v1.glb', (P0/'animations/exercise.glb').read_bytes())
    for key, filename in BUILDING_FILES.items():
        embed_building_texture(P0/'kenney'/filename, destination/(key+'.glb'))


# CLI仅构建候选；注册表逐字节复用既有登记，不新增商品。
def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/asset-pipeline/resources')
    options = parser.parse_args(arguments)
    specification = importlib.util.spec_from_file_location('legacy_candidate', Path(__file__).with_name('asset-pipeline-candidate.py'))
    helper = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(helper)
    output = helper.validate_candidate_output(ROOT, options.output)
    if (output / 'candidate.json').exists():
        raise ValueError('candidate output already finalized; choose a new output directory')
    baseline = helper.capture_baseline(ROOT)
    dependency_paths = [Path(__file__)]
    for source in [P0/'animations/exercise.glb', *[P0/'kenney'/name for name in BUILDING_FILES.values()]]:
        dependency_paths.extend(helper.source_dependencies(source))
    dependencies = helper.capture_dependencies(ROOT, dependency_paths)
    prepare(output)
    shutil.copyfile(ROOT / 'internal/assets/builtin/catalog.json', output / 'internal/assets/builtin/catalog.json')
    helper.finalize_candidate(ROOT, output, 'resources', baseline=baseline, dependencies=dependencies)


if __name__ == '__main__':
    main()
