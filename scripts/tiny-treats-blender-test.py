"""在 Blender 中用实际交付 GLB 验证地板、墙体及贯通入口。"""

import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


# 配置插值与实际floor射线逐点比较，覆盖侧平台、倒角、重叠面和房屋局部坐标。
def verify_walk_surface(house):
    surface = house['walk_surfaces']
    vertices = surface['vertices']
    assert len({tuple(vertex.values()) for vertex in vertices}) == len(vertices)
    floor = bpy.data.objects['floor']
    floor.data.calc_loop_triangles()
    actual_vertices = [floor.matrix_world @ vertex.co for vertex in floor.data.vertices]
    bvh = BVHTree.FromPolygons(actual_vertices, [triangle.vertices[:] for triangle in floor.data.loop_triangles], all_triangles=True)
    samples = []
    for face in surface['triangles']:
        assert len(face) == 3 and all(isinstance(index, int) and 0 <= index < len(vertices) for index in face)
        points = [vertices[index] for index in face]
        a, b, c = [Vector((point['x_cm'], -point['z_cm'], point['y_cm'])) for point in points]
        assert (b - a).cross(c - a).z > 0, ('支撑面必须朝上', face)
        samples.append((sum(point['x_cm'] for point in points) / 3, sum(point['z_cm'] for point in points) / 3))
    samples.extend([(0, house['door_center']['z_cm']), (120, 250), (-120, 250), (200, 350), (-200, 350)])
    for x, z in samples:
        heights = []
        for face in surface['triangles']:
            a, b, c = [vertices[index] for index in face]
            denominator = (b['z_cm'] - c['z_cm']) * (a['x_cm'] - c['x_cm']) + (c['x_cm'] - b['x_cm']) * (a['z_cm'] - c['z_cm'])
            u = ((b['z_cm'] - c['z_cm']) * (x - c['x_cm']) + (c['x_cm'] - b['x_cm']) * (z - c['z_cm'])) / denominator
            v = ((c['z_cm'] - a['z_cm']) * (x - c['x_cm']) + (a['x_cm'] - c['x_cm']) * (z - c['z_cm'])) / denominator
            if min(u, v, 1 - u - v) >= -1e-8:
                heights.append(u * a['y_cm'] + v * b['y_cm'] + (1 - u - v) * c['y_cm'])
        actual, *_ = bvh.ray_cast(Vector((x / 100, -z / 100, 1)), Vector((0, 0, -1)))
        assert bool(heights) == (actual is not None), ('支撑面覆盖与GLB不符', x, z)
        if actual is not None:
            assert abs(max(heights) - actual.z * 100) < .001, ('支撑高度与GLB不符', x, z, heights, actual.z * 100)
    print('实际支撑面检查通过', house['house_key'], len(vertices), len(surface['triangles']), len(samples), flush=True)


# 射线使用 glTF 的米制位置，统一转换到 Blender Z 向上的坐标。
def hit_at(origin, direction, allow_missing=False):
    source = Vector((origin[0], -origin[2], origin[1]))
    ray = Vector((direction[0], -direction[2], direction[1]))
    hit, location, *_ = bpy.context.scene.ray_cast(bpy.context.evaluated_depsgraph_get(), source, ray)
    if not hit:
        if allow_missing:
            return None
        raise AssertionError(f'未命中预期表面: {origin} {direction}')
    return (location.x, location.z, -location.y)


# 平台与倒角对照真实顶面；垂直阶缘附近的极短插值段不作为精度断言。
def verify_entry_profile(house):
    profile = house['entry_height_profile']
    samples = [(profile[0]['z_cm'], profile[0]['y_cm'])]
    for left, right in zip(profile, profile[1:]):
        distance = right['z_cm'] - left['z_cm']
        assert distance > 0, ('入口高度点必须沿门外方向递增', left, right)
        if distance < 1:
            continue
        for ratio in (.25, .5, .75):
            samples.append((left['z_cm'] + ratio * distance, left['y_cm'] + ratio * (right['y_cm'] - left['y_cm'])))
    for z_cm, expected_cm in samples:
        actual = hit_at((house['door_center']['x_cm'] / 100, .8, z_cm / 100), (0, -1, 0))
        actual_cm = actual[1] * 100
        assert abs(actual_cm - expected_cm) < 1, ('入口高度与实际GLB不一致', house['house_key'], z_cm, expected_cm, actual_cm)
    # 最后零点必须位于实际台阶之外；场景地面不属于房屋GLB。
    ground = profile[-1]
    assert ground['y_cm'] == 0, ground
    assert hit_at((house['door_center']['x_cm'] / 100, .8, ground['z_cm'] / 100), (0, -1, 0), allow_missing=True) is None, ground
    print('实际入口高度检查通过', house['house_key'], len(samples), flush=True)


# 同时检查几何和渲染节点，不能用配置声明代替交付模型事实。
def verify_house(house, directory):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(directory / (house['house_key'] + '.glb')))
    expected_nodes = {'floor', 'roof', 'wall_north', 'wall_south', 'wall_east', 'wall_west'}
    assert {item.name for item in bpy.context.scene.objects if item.type == 'MESH'} == expected_nodes
    room = {key: value / 100 for key, value in house['interior'].items()}
    center = ((room['min_x_cm'] + room['max_x_cm']) / 2, 1.5, (room['min_z_cm'] + room['max_z_cm']) / 2)
    floor = hit_at((center[0], .8, center[2]), (0, -1, 0))
    assert abs(floor[1] - house['floor_height_cm'] / 100) < .001, floor
    for axis, direction, boundary in [(0, (1, 0, 0), 'max_x_cm'), (0, (-1, 0, 0), 'min_x_cm'), (2, (0, 0, -1), 'min_z_cm')]:
        wall = hit_at(center, direction)
        assert abs(wall[axis] - room[boundary]) < .001, (boundary, wall)
    # 从屋外穿过门洞应直接看到主室后墙，途中不能残留源模型封板。
    door = house['door_center']
    for fraction in (-.85, 0, .85):
        opening = hit_at((fraction * house['door_width_cm'] / 200, 1.5, door['z_cm'] / 100 + 3.5), (0, 0, -1))
        assert abs(opening[2] - room['min_z_cm']) < .001, ('入口未贯通', opening)
    south = hit_at((house['door_width_cm'] / 200 + .15, 1.5, center[2]), (0, 0, 1))
    assert abs(south[2] - room['max_z_cm']) < .001, south
    verify_entry_profile(house)
    verify_walk_surface(house)
    print('实际房屋几何检查通过', house['house_key'], flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--models', type=Path)
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    options = parser.parse_args(arguments)
    path = options.manifest
    for item in json.loads(path.read_text())['houses']:
        verify_house(item, options.models or path.parent)
