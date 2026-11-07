"""用真实Blender布尔结果检查臂筒通孔、外壁属性、装饰保留与失败边界。"""
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# 工具模块使用独立文件，不把测试替身或制作样件放进正式制作实现。
def load(name, filename):
    specification = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


# 样件用真实骨架与双材质，避免内壁错误沿用材质槽零也能蒙混通过。
def sample_cuff(bpy):
    from mathutils import Matrix

    bpy.ops.wm.read_factory_settings(use_empty=True)
    configuration = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    bpy.ops.import_scene.gltf(filepath=str(ROOT / configuration['canonical_input']['path']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=.12, depth=.15,
                                      location=(.62, .005, 1.10676), rotation=(0, math.pi / 2, 0))
    obj = bpy.context.object
    obj.name = '开孔验证臂筒'
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    decoration = bpy.data.materials.new('来源装饰材质')
    decoration.diffuse_color = (.6, .04, .02, 1)
    metal = bpy.data.materials.new('来源金属材质')
    metal.diffuse_color = (.45, .5, .54, 1)
    obj.data.materials.append(decoration)
    obj.data.materials.append(metal)
    for face in obj.data.polygons:
        face.material_index = 1
    obj.vertex_groups.new(name='lowerarm.l').add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    obj.modifiers.new('真实骨架', 'ARMATURE').object = rig
    return obj, rig, metal, decoration


# 真实循环角点同时保存位置与UV，输出重新三角化不应改变未被刀具接触的外壁。
def corner_signatures(obj, faces=None):
    uv = obj.data.uv_layers.active
    result = set()
    for face in obj.data.polygons:
        if faces is not None and face.index not in faces:
            continue
        for index in face.loop_indices:
            vertex = obj.data.vertices[obj.data.loops[index].vertex_index]
            result.add((tuple(round(value, 6) for value in obj.matrix_world @ vertex.co),
                        tuple(round(value, 6) for value in uv.data[index].uv) if uv else ()))
    return result


# 真实源袖管带glTF拆点，不能仅用共享顶点的自建圆筒代表制作输入。
def verify_real_source_cup(bpy, opening, fitting):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    configuration = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(item for item in configuration['sources'] if item['key'] == 'kaykit-legacy-skeleton-archer')
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    obj = bpy.data.objects['upper_native']
    checked = 0
    for component in fitting.mesh_components(obj):
        if component['materials'] != ['Stone'] or fitting.component_region(component['center'], rig) != 'forearm':
            continue
        part = obj.copy()
        part.data = obj.data.copy()
        bpy.context.collection.objects.link(part)
        opening.keep_faces(part, set(component['faces']))
        source_topology = opening.topology(part)
        if source_topology['euler'] != 1:
            bpy.data.objects.remove(part, do_unlink=True)
            continue
        fitting.fit_upper_clothing([part], rig, [{'selector': {}, 'center_on_axis': True, 'scale': [1, 1, 2]}])
        if not opening.boundary_encircles_axis(part, rig, 'lowerarm'):
            bpy.data.objects.remove(part, do_unlink=True)
            continue
        result = opening.open_cuff_components(fitting.mesh_components(part), rig,
                                             {'bone': 'lowerarm', 'radii': [.02, .02], 'wall_thickness': .003})
        assert result[0]['status'] == 'opened' and result[0]['result_topology']['euler'] == 0
        assert result[0]['lost_external_samples'] == 0
        assert all(abs(sum(group.weight for group in vertex.groups) - 1) < .00001 for vertex in part.data.vertices)
        print('真实来源开放袖管检查通过', source['key'], source_topology['faces'], '面', flush=True)
        checked += 1
    assert checked, '没有检查到真实源开放袖管'


# 真实旧侍从臂筒同时检查内衬在原轮廓内、内法线、源外壁与UV不变。
def verify_real_lining(bpy, opening, fitting):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    configuration = json.loads((ROOT / 'scripts/modular-character-sources.json').read_text())
    source = next(item for item in configuration['sources'] if item['key'] == 'kaykit-legacy-skeleton-minion')
    bpy.ops.import_scene.gltf(filepath=str(ROOT / source['normalized_model']))
    rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    rig.data.pose_position = 'REST'
    obj = bpy.data.objects['upper_native']
    parts = [component for component in fitting.mesh_components(obj)
             if component['materials'] == ['Stone'] and len(component['faces']) == 72]
    assert len(parts) == 2
    opening.keep_faces(obj, {index for part in parts for index in part['faces']})
    fitting.fit_upper_clothing([obj], rig, [{'selector': {}, 'center_on_axis': True,
        'scale': [1, .9, 1.8], 'translation': [-.195, 0, .013], 'bind_bone': 'lowerarm'}])
    walls = set()
    for component in fitting.mesh_components(obj):
        center, _, across, up = opening.bone_frame(obj, rig, 'lowerarm')
        # 成对部件分侧计算骨轴，避免用整对象的中心判定左右。
        part = obj.copy()
        part.data = obj.data.copy()
        bpy.context.collection.objects.link(part)
        opening.keep_faces(part, set(component['faces']))
        center, _, across, up = opening.bone_frame(part, rig, 'lowerarm')
        for index in component['faces']:
            face = obj.data.polygons[index]
            points = [obj.matrix_world @ obj.data.vertices[vertex].co - center for vertex in face.vertices]
            if all((point.dot(across) / .08) ** 2 + (point.dot(up) / .079) ** 2 > 1.0001 for point in points):
                walls.add(index)
        bpy.data.objects.remove(part, do_unlink=True)
    corners = corner_signatures(obj, walls)
    result = opening.open_cuff_components(fitting.mesh_components(obj), rig, {
        'bone': 'lowerarm', 'radii': [.08, .079], 'lining': {
            'radii': [.075, .074], 'contact_radii': [.031, .031], 'axis_offset': .01,
            'thickness': .0015, 'color': [.035, .04, .045, 1]}})
    assert len(result) == 2
    for item in result:
        lining = item['lining']
        assert lining['outside_source_volume_vertices'] == 0
        assert lining['inner_surface_normals_inward']
        assert lining['topology']['euler'] == 0 and not lining['topology']['boundary_edges']
        assert item['lost_external_samples'] == 0
    assert corners <= corner_signatures(obj), '金属原有顶点与UV因内衬改变'
    assert all(abs(sum(group.weight for group in vertex.groups) - 1) < .00001 for vertex in obj.data.vertices)
    print('真实旧侍从内衬、外轮廓与内侧法线检查通过', flush=True)


# 孔洞的几何、外壁UV、材质槽和新顶点蒙皮都由实际操作后的网格证明。
def verify():
    import bpy
    import bmesh

    opening = load('cuff_opening', 'modular-character-cuff-opening.py')
    fitting = load('cuff_components', 'modular-character-clothing-fit.py')
    obj, rig, metal, decoration = sample_cuff(bpy)
    walls = {face.index for face in obj.data.polygons if abs(face.normal.x) < .1}
    expected_corners = corner_signatures(obj, walls)
    original_name = obj.name
    result = opening.open_cuff_components(fitting.mesh_components(obj), rig,
                                         {'bone': 'lowerarm', 'radii': [.08, .079]})
    assert len(result) == 1 and result[0]['status'] == 'opened'
    assert result[0]['source_topology']['euler'] == 2
    assert result[0]['result_topology']['euler'] == 0
    assert result[0]['result_topology']['boundary_edges'] == 0
    assert result[0]['result_topology']['non_manifold_edges'] == 0
    assert result[0]['removed_internal_samples'] > 0
    assert result[0]['lost_external_samples'] == 0
    assert expected_corners <= corner_signatures(obj), '刀具以外的外壁位置或UV改变'
    assert obj.name == original_name, '调用方引用的对象身份改变'
    assert all(obj.data.materials[face.material_index] == metal for face in obj.data.polygons), '内壁用了错误材质槽'
    assert all(abs(sum(group.weight for group in vertex.groups) - 1) < .00001 for vertex in obj.data.vertices), '新内壁顶点丢失骨骼权重'
    # 独立的开放装饰原样保留，不参与实心体布尔运算。
    mesh = bpy.data.meshes.new('源开放装饰')
    mesh.from_pydata([(.3, .2, 1.2), (.34, .2, 1.2), (.32, .2, 1.24)], [], [(0, 1, 2)])
    mesh.materials.append(decoration)
    ornament = bpy.data.objects.new('源开放装饰', mesh)
    bpy.context.collection.objects.link(ornament)
    before = corner_signatures(ornament)
    retained = opening.open_cuff_components(fitting.mesh_components(ornament), rig,
                                           {'bone': 'lowerarm', 'radii': [.08, .079]})
    assert retained[0]['status'] == 'retained-open-source'
    assert before == corner_signatures(ornament)
    # 真正的一端开放袖管可向内加厚，局部扣件即使同样声明薄壁也不能被误加厚。
    retained = opening.open_cuff_components(fitting.mesh_components(ornament), rig,
                                           {'bone': 'lowerarm', 'radii': [.08, .079], 'wall_thickness': .004})
    assert retained[0]['status'] == 'retained-open-source' and before == corner_signatures(ornament)
    obj, rig, metal, _ = sample_cuff(bpy)
    opening.keep_faces(obj, {face.index for face in obj.data.polygons if face.normal.x > -.9})
    # glTF会为UV和法线拆点；真实袖管必须先恢复几何连接再执行Solidify。
    disconnected = bmesh.new()
    disconnected.from_mesh(obj.data)
    bmesh.ops.split_edges(disconnected, edges=list(disconnected.edges))
    disconnected.to_mesh(obj.data)
    disconnected.free()
    assert opening.topology(obj)['boundary_edges'] > 0
    assert opening.boundary_encircles_axis(obj, rig, 'lowerarm')
    walls = {face.index for face in obj.data.polygons if abs(face.normal.x) < .1}
    expected_corners = corner_signatures(obj, walls)
    result = opening.open_cuff_components(fitting.mesh_components(obj), rig,
                                         {'bone': 'lowerarm', 'radii': [.08, .079], 'wall_thickness': .004})
    assert result[0]['status'] == 'opened' and result[0]['solidify_wall_thickness'] == .004
    assert result[0]['result_topology']['euler'] == 0 and result[0]['result_topology']['boundary_edges'] == 0
    assert result[0]['lost_external_samples'] == 0 and expected_corners <= corner_signatures(obj)
    assert all(obj.data.materials[face.material_index] == metal for face in obj.data.polygons)
    assert all(abs(sum(group.weight for group in vertex.groups) - 1) < .00001 for vertex in obj.data.vertices)
    verify_real_source_cup(bpy, opening, fitting)
    verify_real_lining(bpy, opening, fitting)
    # 过大的孔不得吞掉整个原件，也不能把空网格伪报为Euler为零的通孔。
    obj, rig, _, _ = sample_cuff(bpy)
    before = corner_signatures(obj)
    original_faces = len(obj.data.polygons)
    try:
        opening.open_cuff_components(fitting.mesh_components(obj), rig,
                                     {'bone': 'lowerarm', 'radii': [.5, .5]})
    except ValueError:
        pass
    else:
        raise AssertionError('过大的孔应拒绝发布')
    assert len(obj.data.polygons) == original_faces and before == corner_signatures(obj), '开孔失败改变了源件'
    print('真实臂筒开孔、外壁UV、材质、蒙皮与失败边界检查通过', flush=True)


if __name__ == '__main__':
    verify()
