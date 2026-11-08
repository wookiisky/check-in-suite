"""从交付 GLB 验证紫尖帽的网格和棕顶牛角盔的面部开口。"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
HAT = 'kaykit-adventurers-mage-head'
HELMET = 'kaykit-legacy-skeleton-warrior-head'


# 按交付目录声明装配人物，使用与画面检查相同的身体、面部和覆盖定义。
def load_models(candidate):
    spec = importlib.util.spec_from_file_location(
        'headwear_appearance', ROOT / 'scripts/verify-modular-character-appearance.py',
    )
    appearance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(appearance)
    directory = candidate or ROOT
    catalog = json.loads((directory / 'internal/character/character-catalog.json').read_text())
    bodies = {entry['character_key']: entry for entry in catalog['characters']}
    wearables = {entry['wearable_key']: entry for entry in catalog['wearables']}
    assets = candidate / 'internal/assets/builtin' if candidate else None
    return appearance, bodies, wearables, assets


# 射线查询使用从 GLB 读入的实际三角面。
def surface(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return BVHTree.FromPolygons(
        [obj.matrix_world @ vertex.co for vertex in mesh.vertices],
        [tuple(triangle.vertices) for triangle in mesh.loop_triangles],
        all_triangles=True,
    )


# 确认紫帽不再含来源发色面，眉毛和头皮仍由所选脸型提供。
def check_hat(objects):
    hat = objects['head_provider']
    uv = hat.data.uv_layers.active.data
    for face in hat.data.polygons:
        center = sum((uv[index].uv for index in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
        assert not (0.125 <= center.x < 0.25 and 0.75 <= center.y <= 1), '紫尖帽含有来源发色面'
    assert {'face_scalp', 'face_brows'} <= objects.keys(), '紫尖帽遮住了微笑脸的头皮或眉毛'


# 从平视和略高的正面核对左右眼、鼻与嘴，头盔不能挡在这些脸部采样点前。
def check_opening(objects):
    head = surface(objects['face_head'])
    helmet = surface(objects['head_provider'])
    for rise in (0, 0.10):
        direction = Vector((0, 1, -rise)).normalized()
        for feature, x, z in [('左眼', -0.18, 1.63), ('右眼', 0.18, 1.63),
                              ('鼻尖', 0, 1.58), ('嘴', 0, 1.43)]:
            origin = Vector((x, -2, z + 1.55 * rise))
            _, _, _, face_distance = head.ray_cast(origin, direction)
            _, _, _, helmet_distance = helmet.ray_cast(origin, direction)
            assert face_distance is not None, f'脸部采样偏离{feature}'
            assert helmet_distance is None or helmet_distance > face_distance, f'棕顶牛角盔遮挡{feature}'


def verify(candidate):
    """分别组装紫尖帽和棕顶牛角盔，核对面部特征与遮挡。"""
    appearance, bodies, wearables, assets = load_models(candidate)
    for key, check in [(HELMET, check_opening), (HAT, check_hat)]:
        scenario = {'body': 'kaykit-medium-v1', 'selection': {'head': key}}
        _, _, selected, _, _, _ = appearance.load_appearance(scenario, bodies, wearables, assets)
        check({obj.name.split('_', 1)[1]: obj for obj in selected})
    print('紫尖帽发色面、微笑脸眉毛和棕顶牛角盔开口检查通过')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path)
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    verify(parser.parse_args(arguments).candidate)
