"""在正式 GLB 的索引和材质层拆分染色区域，沿用已有的网格与蒙皮。"""

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from io import BytesIO
import json
import struct

from PIL import Image

COMPONENT_FORMAT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}
COMPONENT_COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}


def srgb_channel(value):
    """将 PNG 的八位 sRGB 分量转换为 glTF 底色使用的线性分量。"""
    channel = value / 255
    return channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4


LINEAR_CHANNELS = tuple(srgb_channel(value) for value in range(256))


def luminance(rgb):
    """按线性光亮度保留贴图中的阴影与明暗差异。"""
    red, green, blue = rgb
    return .2126 * red + .7152 * green + .0722 * blue


def grayscale_byte(value):
    """将归一化线性亮度编码为 PNG 中的八位 sRGB。"""
    channel = min(1, value)
    return round(255 * (channel * 12.92 if channel <= .0031308 else 1.055 * channel ** (1 / 2.4) - .055))


@dataclass
class Surface:
    """选区规则读取一组索引三角形以及实际取色所用的贴图。"""

    triangles: list[tuple]  # 三个顶点编号一组，沿用导出时的顺序。
    positions: list[tuple]  # 与索引对应的局部位置。
    uvs: list[tuple]  # 底色贴图使用的 UV 坐标。
    image: Image.Image  # 内嵌贴图已解码为 RGBA，保留原透明度。

    def sample_uv(self, uv):
        """按 glTF 默认重复采样，用最近像素确定离线选区。"""
        u, v = uv
        return self.image.getpixel((int((u % 1) * self.image.width), int((v % 1) * self.image.height)))[:3]

    def sample_triangle(self, triangle_id, weights=(1 / 3, 1 / 3, 1 / 3)):
        """取指定三角形的重心坐标处的底色。"""
        uvs = [self.uvs[index] for index in self.triangles[triangle_id]]
        return self.sample_uv(tuple(sum(weight * value for weight, value in zip(weights, axis)) for axis in zip(*uvs)))


class Glb:
    """以原 GLB 为底稿，仅替换配方选定的材质引用和索引。"""

    def __init__(self, raw):
        """读取内部素材使用的 glTF 2.0 单缓冲区容器。"""
        magic, version, length, json_size, json_kind = struct.unpack_from('<4sIII4s', raw)
        if (magic, version, length, json_kind) != (b'glTF', 2, len(raw), b'JSON'):
            raise ValueError('需要 glTF 2.0 GLB')
        self.document = json.loads(raw[20:20 + json_size])  # 原节点、蒙皮及资源引用。
        binary_size, binary_kind = struct.unpack_from('<I4s', raw, 20 + json_size)
        if binary_kind != b'BIN\0' or 28 + json_size + binary_size != length or len(self.document['buffers']) != 1:
            raise ValueError('需要单个内嵌 GLB 缓冲区')
        self.binary = bytearray(raw[28 + json_size:28 + json_size + self.document['buffers'][0]['byteLength']])  # 原始缓冲区及追加的贴图。
        self._meshes = {node['name']: node['mesh'] for node in self.document['nodes'] if 'mesh' in node}  # 按目录节点名查网格。
        self._mesh_uses = Counter(node['mesh'] for node in self.document['nodes'] if 'mesh' in node)  # 避免染到引用同一网格的其他节点。
        self._images = {}  # 源贴图解码缓存。
        self._neutral_textures = {}  # 同源图集和明暗锚点共用一个中性贴图。
        self._dyed_meshes = set()  # 一次性处理每个网格的所有选区，防止 primitive 索引偏移。

    def _primitives(self, node_name):
        """按目录中的真实节点找到三角形材质组。"""
        return self.document['meshes'][self._meshes[node_name]]['primitives']

    def primitive_count(self, node_name):
        """返回一个网格节点的材质组数量。"""
        return len(self._primitives(node_name))

    def _view_bytes(self, index):
        """读取内嵌贴图所在的完整缓冲区片段。"""
        view = self.document['bufferViews'][index]
        start = view.get('byteOffset', 0)
        return self.binary[start:start + view['byteLength']]

    def _accessor_values(self, index):
        """按 GLB 声明的组件类型、偏移和步长读取选区所需属性。"""
        accessor = self.document['accessors'][index]
        view = self.document['bufferViews'][accessor['bufferView']]
        codec = struct.Struct('<' + COMPONENT_FORMAT[accessor['componentType']] * COMPONENT_COUNT[accessor['type']])
        stride = view.get('byteStride', codec.size)
        offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        return [codec.unpack_from(self.binary, offset + item * stride) for item in range(accessor['count'])]

    def _source_image(self, texture_index):
        """按源图像身份解码，供共用图集的节点反复读取。"""
        image_index = self.document['textures'][texture_index]['source']
        if image_index not in self._images:
            image = self.document['images'][image_index]
            with Image.open(BytesIO(self._view_bytes(image['bufferView']))) as source:
                self._images[image_index] = source.convert('RGBA')
        return self._images[image_index]

    def surface(self, node_name, primitive_index=0):
        """读取现有三角形，使用底色贴图实际声明的 UV 通道。"""
        primitive = self._primitives(node_name)[primitive_index]
        if primitive.get('mode', 4) != 4:
            raise ValueError('染色区域需要索引三角形')
        attributes = primitive['attributes']
        color_texture = self.document['materials'][primitive['material']]['pbrMetallicRoughness']['baseColorTexture']
        indices = self._accessor_values(primitive['indices'])
        return Surface(
            [(a[0], b[0], c[0]) for a, b, c in zip(indices[::3], indices[1::3], indices[2::3], strict=True)],
            self._accessor_values(attributes['POSITION']),
            self._accessor_values(attributes[f'TEXCOORD_{color_texture.get("texCoord", 0)}']),
            self._source_image(color_texture['index']),
        )

    def _neutral_texture(self, texture_index, anchor):
        """复制底色贴图为中性色，保留线性明暗、透明度和原采样方式。"""
        texture = self.document['textures'][texture_index]
        key = (texture['source'], texture.get('sampler'), anchor)
        if key in self._neutral_textures:
            return self._neutral_textures[key]
        source = self._source_image(texture_index)
        gray_by_rgb = {}

        def gray(rgb):
            if rgb not in gray_by_rgb:
                intensity = luminance(tuple(LINEAR_CHANNELS[value] for value in rgb))
                gray_by_rgb[rgb] = grayscale_byte(intensity / anchor)
            return gray_by_rgb[rgb]

        pixels = bytes(value for r, g, b, a in source.get_flattened_data() for value in (gray((r, g, b)), a))
        neutral = Image.frombytes('LA', source.size, pixels)
        png = BytesIO()
        neutral.save(png, format='PNG')
        data = png.getvalue()
        self.binary.extend(b'\0' * (-len(self.binary) % 4))
        view_index = len(self.document['bufferViews'])
        self.document['bufferViews'].append({'buffer': 0, 'byteOffset': len(self.binary), 'byteLength': len(data)})
        self.binary.extend(data)
        image_index = len(self.document['images'])
        self.document['images'].append({'bufferView': view_index, 'mimeType': 'image/png'})
        result = len(self.document['textures'])
        self.document['textures'].append({**texture, 'source': image_index})
        self._neutral_textures[key] = result
        return result

    def _split_primitive(self, primitive, surface, chosen, material_index):
        """在原索引范围内按原顺序重排两组面，顶点属性仍引用原 accessor。"""
        dyed = {**primitive, 'material': material_index}
        if len(chosen) == len(surface.triangles):
            return [dyed]

        accessor_index = primitive['indices']
        accessor = self.document['accessors'][accessor_index]
        view = self.document['bufferViews'][accessor['bufferView']]
        fixed_indices = [index for number, triangle in enumerate(surface.triangles) if number not in chosen for index in triangle]
        dyed_indices = [index for number, triangle in enumerate(surface.triangles) if number in chosen for index in triangle]
        encoding = COMPONENT_FORMAT[accessor['componentType']]
        start = accessor.get('byteOffset', 0)
        dyed_accessor = {**accessor, 'byteOffset': start + struct.calcsize('<' + encoding) * len(fixed_indices)}
        offset = view.get('byteOffset', 0) + start
        struct.pack_into('<' + encoding * accessor['count'], self.binary, offset, *fixed_indices, *dyed_indices)
        for group, indices in ((accessor, fixed_indices), (dyed_accessor, dyed_indices)):
            group.update(count=len(indices), min=[min(indices)], max=[max(indices)])
        dyed['indices'] = len(self.document['accessors'])
        self.document['accessors'].append(dyed_accessor)
        return [primitive, dyed]

    def _index_range_is_owned(self, index):
        """同一索引缓冲区可有多个连续段，只修改当前 accessor 的独立段。"""
        accessors = self.document['accessors']
        target = accessors[index]
        view_index = target['bufferView']
        if 'byteStride' in self.document['bufferViews'][view_index]:
            return False
        size = struct.calcsize('<' + COMPONENT_FORMAT[target['componentType']])
        start = target.get('byteOffset', 0)
        stop = start + size * target['count']
        for other_index, other in enumerate(accessors):
            if other_index == index or other.get('bufferView') != view_index:
                continue
            other_start = other.get('byteOffset', 0)
            other_size = struct.calcsize('<' + COMPONENT_FORMAT[other['componentType']]) * COMPONENT_COUNT[other['type']]
            if other_start < stop and start < other_start + other_size * other['count']:
                return False
        return True

    def add_dye(self, material_name, selections, default_srgb=None):
        """为同款的已选三角形添加一种可换色材质，原色优先采用配方锚点。"""
        if not selections or any(material.get('name') == material_name for material in self.document['materials']):
            raise ValueError(f'染色材质无选区或重名：{material_name}')

        prepared = {}
        source_materials = set()
        index_uses = Counter(primitive.get('indices') for mesh in self.document['meshes'] for primitive in mesh['primitives'])
        for (node, index), chosen in sorted(selections.items()):
            mesh = self._meshes[node]
            if mesh in self._dyed_meshes or self._mesh_uses[mesh] != 1:
                raise ValueError(f'染色网格需要独立并一次处理：{node}')
            primitive = self._primitives(node)[index]
            surface = self.surface(node, index)
            if not chosen or min(chosen) < 0 or max(chosen) >= len(surface.triangles):
                raise ValueError(f'染色三角形选区越界：{node} {index}')
            if len(chosen) < len(surface.triangles):
                accessor_index = primitive['indices']
                if index_uses[accessor_index] != 1 or not self._index_range_is_owned(accessor_index):
                    raise ValueError(f'染色选区的索引必须独占其缓冲区：{node} {index}')
            prepared.setdefault(node, {})[index] = (surface, chosen)
            source_materials.add(primitive['material'])
        if len(source_materials) != 1:
            raise ValueError(f'同一可染材质需使用相同来源材质：{material_name}')

        material = deepcopy(self.document['materials'][source_materials.pop()])
        material['name'] = material_name
        pbr = material['pbrMetallicRoughness']
        if default_srgb is None:
            samples = [surface.sample_triangle(index, weights)
                       for groups in prepared.values() for surface, chosen in groups.values()
                       for index in sorted(chosen)
                       for weights in ((1 / 3, 1 / 3, 1 / 3), (.8, .1, .1), (.1, .8, .1), (.1, .1, .8))]
            colors = [tuple(LINEAR_CHANNELS[value] for value in color) for color in samples]
            mean = tuple(sum(channel) / len(colors) for channel in zip(*colors))
            if not max(mean):
                raise ValueError(f'无法从全黑选区推断原色：{material_name}')
            scale = min(max(map(luminance, colors)) / luminance(mean), 1 / max(mean))
            tint = [min(1, channel * scale) for channel in mean]
        else:
            tint = [LINEAR_CHANNELS[value] for value in default_srgb]
        anchor = luminance(tint)
        if not anchor:
            raise ValueError(f'染色底色不能为全黑：{material_name}')
        pbr['baseColorFactor'] = [*tint, pbr.get('baseColorFactor', [1, 1, 1, 1])[3]]
        color_texture = pbr['baseColorTexture']
        color_texture['index'] = self._neutral_texture(color_texture['index'], anchor)
        material_index = len(self.document['materials'])
        self.document['materials'].append(material)
        for node, groups in prepared.items():
            primitives = self._primitives(node)
            for index, (surface, chosen) in sorted(groups.items(), reverse=True):
                primitives[index:index + 1] = self._split_primitive(primitives[index], surface, chosen, material_index)
            self._dyed_meshes.add(self._meshes[node])

    def to_bytes(self):
        """按 GLB chunk 对齐规则写出确定性结果，不覆写输入文件。"""
        self.document['buffers'][0]['byteLength'] = len(self.binary)
        content = json.dumps(self.document, separators=(',', ':')).encode()
        content += b' ' * (-len(content) % 4)
        binary = bytes(self.binary) + b'\0' * (-len(self.binary) % 4)
        return (struct.pack('<4sIII4s', b'glTF', 2, 28 + len(content) + len(binary), len(content), b'JSON')
                + content + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
