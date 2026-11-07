"""只读核对Warrior上背灰色闭面，两身体八姿势须保留3mm真实遮挡余量。"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.geometry import intersect_point_line

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'kaykit-skeletons-warrior-upper'


# 复用既有组装、姿态及实际表面工具，不调用任何fit函数。
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 将实际输入字节绑定到报告。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# 只采样实际可见的既有灰面；源开边3mm内单列，不把它冒充闭面域。
def measure(armor, source_points, domain, under, subdivisions):
    geometric = load('warrior_upper_actual_surface', 'modular-character-torso-back-fit-blender-test.py')
    fitted = geometric.tree([armor])
    collider = geometric.tree(under)
    points, triangles = geometric.evaluated_geometry(armor)
    edges = Counter()
    for triangle in triangles:
        coordinates = [tuple(source_points[index]) for index in triangle]
        for a,b in zip(coordinates, coordinates[1:]+coordinates[:1]):
            edges[tuple(sorted([a,b]))] += 1
    boundary = [(Vector(a),Vector(b))for (a,b),count in edges.items()if count == 1]
    result = {'samples':0,'exposed':0,'minimum_clearance':None,'maximum_protrusion':0.,'source_edge_band_excluded':0,'examples':[]}
    for face in domain:
        indices = triangles[face]
        a,b,c = [points[index]for index in indices]
        ra,rb,rc = [source_points[index]for index in indices]
        local_edges = [(start,end)for start,end in boundary if all(max(start[axis],end[axis]) >= min(ra[axis],rb[axis],rc[axis])-.003
                       and min(start[axis],end[axis]) <= max(ra[axis],rb[axis],rc[axis])+.003 for axis in range(3))]
        for row in range(1,subdivisions):
            for column in range(1,subdivisions-row):
                u,v = row/subdivisions,column/subdivisions
                rest = ra+(rb-ra)*u+(rc-ra)*v
                if not (abs(rest.x)<.18 and rest.y>.10 and 1.045<rest.z<1.205):
                    continue
                near = False
                for start,end in local_edges:
                    closest,t = intersect_point_line(rest,start,end)
                    closest = start if t<0 else end if t>1 else closest
                    if (rest-closest).length <= .003:
                        near=True
                        break
                if near:
                    result['source_edge_band_excluded'] += 1
                    continue
                point = a+(b-a)*u+(c-a)*v
                origin,direction = point+Vector((0,.8,0)),Vector((0,-1,0))
                cloth = fitted.ray_cast(origin,direction,2)
                if cloth[3] is None or abs(cloth[3]-.8)>1e-5:
                    continue
                body = collider.ray_cast(origin,direction,2)
                result['samples'] += 1
                if body[3] is None:
                    continue
                clearance = body[3]-cloth[3]
                result['minimum_clearance'] = clearance if result['minimum_clearance'] is None else min(result['minimum_clearance'],clearance)
                if clearance < -.0001:
                    result['exposed'] += 1
                    result['maximum_protrusion'] = max(result['maximum_protrusion'],-clearance)
                if clearance < .003 and len(result['examples'])<24:
                    result['examples'].append({'triangle':face,'rest_point':list(rest),'cloth_point':list(cloth[0]),'body_point':list(body[0]),'clearance':clearance})
    return result


# 输入必须已经制作完成；本入口不修改、导出或适配模型。
def main(options):
    assembly = load('warrior_upper_assembly','verify-modular-character-appearance.py')
    motion = load('warrior_upper_motion','verify-modular-character-arms.py')
    component = load('warrior_upper_components','modular-character-clothing-fit.py')
    catalog = json.loads(options.catalog.read_text())
    bodies = {item['character_key']:item for item in catalog['characters']}
    wearables = {item['wearable_key']:item for item in catalog['wearables']}
    poses = [(item['motion'],item['frame'])for item in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
    report = {'status':'running','fit_applied':False,'mode':'verify-actual-GLB-no-fit','test_sha256':sha(__file__),
              'catalog_sha256':sha(options.catalog),'required_clearance':options.minimum_clearance,'cases':[],'inputs':{},
              'domain':{'component_triangles':482,'abs_x_max':.18,'rest_y_min':.10,'rest_z_bounds':[1.045,1.205],'source_boundary_band':.003,'source_triangle_vertex_z_max':1.17}}
    for body_key in bodies:
        paths={}
        body,rig,selected,hashes,selection,sources = assembly.load_appearance({'body':body_key,'selection':{'upper':TARGET}},bodies,wearables,options.assets,paths)
        item = wearables[TARGET]
        armor = sources[item['model_asset_key']]['upper_outfit001']
        components = [part for part in component.mesh_components(armor)if len(part['faces']) == 482]
        if len(components) != 1:
            raise ValueError('未唯一找到原482面Warrior灰胸甲组件')
        polygons = set(components[0]['faces'])
        armor.data.calc_loop_triangles()
        source_points = [armor.matrix_world@vertex.co for vertex in armor.data.vertices]
        # 原横条属于顶点最高1.16145m的闭板；延伸到1.240m的原领口另行实审。
        # 本局部场只沿后向移动，因此此Z分域与原R6来源相同。
        domain = [triangle.index for triangle in armor.data.loop_triangles
                  if triangle.polygon_index in polygons and max(source_points[index].z for index in triangle.vertices) <= 1.17]
        base = sources[body['model_asset_key']]
        under = [base[name]for name in body['fixed_nodes']+[node for nodes in body['body_regions'].values()for node in nodes]if name in base and base[name] in selected]
        actions = motion.load_actions(bpy,body,hashes,options.assets,paths,poses)
        report['inputs'].update({key:{'path':paths[key],'sha256':value}for key,value in hashes.items()})
        for semantic,frame in poses:
            motion.apply_pose(bpy,rig,body,actions,semantic,frame)
            result = measure(armor,source_points,domain,under,options.subdivisions)
            result.update(body=body_key,wearable_key=TARGET,motion=semantic,frame=frame)
            result['status'] = 'passed' if result['samples'] and result['exposed']==0 and result['minimum_clearance'] is not None and result['minimum_clearance']>=options.minimum_clearance else 'failed'
            report['cases'].append(result)
            print('Warrior上背闭面检查',body_key,semantic,frame,result['status'],result['samples'],result['exposed'],result['minimum_clearance'],flush=True)
    report['status'] = 'passed' if all(item['status']=='passed'for item in report['cases'])else 'failed'
    report['summary'] = {'cases':len(report['cases']),'samples':sum(item['samples']for item in report['cases']),
                         'exposed':sum(item['exposed']for item in report['cases']),
                         'minimum_clearance':min(item['minimum_clearance']for item in report['cases']if item['minimum_clearance']is not None)}
    report['limits'] = ['Only specified source-supported upper-back ROI and eight actual poses; not full continuous animation or all wardrobe pairings.',
                        'Source-edge band3mm is excluded and separately counted; source attributes and visual appearance require independent evidence.',
                        'Upper source collar triangles extending above1.17m to1.240m are outside this closed-panel conclusion and require actual image review; existing wide-domain failure reports are retained.']
    options.report.parent.mkdir(parents=True,exist_ok=True)
    options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 0 if report['status']=='passed'else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--assets',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--minimum-clearance',type=float,default=.003)
    parser.add_argument('--subdivisions',type=int,default=48)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    raise SystemExit(main(args))
