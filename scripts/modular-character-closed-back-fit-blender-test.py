"""最终GLB的Rogue腰背回归；Skeleton清除可见穿出，Human严格对照原输入。"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_point_line

ROOT=Path(__file__).resolve().parents[1]


# 明确引用现有组装、动作和几何工具，不另造运行时穿戴解释。
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 验证报告绑定本次实际文件字节。
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


torso=load('closed_back_geometry','modular-character-torso-back-fit-blender-test.py')


# 背向来源衣片的主面域；不把领口、四肢和后视可见的前胸内壁混作腰背板。
def focused_check(obj, original_coordinates, domain, underlying, occluders, bounds, subdivisions=64):
 fitted=torso.tree([obj]);under=torso.tree(underlying);other=torso.tree(occluders) if occluders else None;points,tris=torso.evaluated_geometry(obj);rest=[obj.matrix_world@p for p in original_coordinates];source=BVHTree.FromPolygons(points,tris,all_triangles=True);counts=0;exposed=0;minimum=None;maximum=0.;examples=[];edge_skipped=0;other_covered=0;raw_minimum=None;raw_protrusions=0
 edge_counts=Counter()
 for tri in tris:
  ps=[tuple(round(float(c),5) for c in rest[i]) for i in tri]
  for a,b in zip(ps,ps[1:]+ps[:1]):edge_counts[tuple(sorted((a,b)))]+=1
 boundaries=[(Vector(a),Vector(b)) for (a,b),n in edge_counts.items() if n==1]
 for face_index in domain:
  ids=tris[face_index];a,b,c=[points[i] for i in ids];ra,rb,rc=[rest[i] for i in ids]
  near_edges=[(a,b) for a,b in boundaries if all(max(a[k],b[k])>=min(ra[k],rb[k],rc[k])-.003 and min(a[k],b[k])<=max(ra[k],rb[k],rc[k])+.003 for k in range(3))]
  for row in range(1,subdivisions):
   for column in range(1,subdivisions-row):
    u,v=row/subdivisions,column/subdivisions;rp=ra+(rb-ra)*u+(rc-ra)*v
    if not (abs(rp.x)<.38 and rp.y>.20 and bounds[0]<rp.z<bounds[1]):continue
    near_boundary=False
    for ea,eb in near_edges:
     closest,t=intersect_point_line(rp,ea,eb);closest=ea if t<0 else (eb if t>1 else closest)
     if (closest-rp).length<=.003:near_boundary=True;break
    if near_boundary:edge_skipped+=1;continue
    p=a+(b-a)*u+(c-a)*v;origin=p+Vector((0,.8,0));direction=Vector((0,-1,0));sh=source.ray_cast(origin,direction,2)
    if sh[3] is None or abs(sh[3]-.8)>.00001:continue
    ch=fitted.ray_cast(origin,direction,2);bh=under.ray_cast(origin,direction,2);counts+=1
    if bh[3] is None or ch[3] is None:continue
    margin=bh[3]-ch[3];raw_minimum=margin if raw_minimum is None else min(raw_minimum,margin);raw_protrusions+=int(margin<-.0001)
    oh=other.ray_cast(origin,direction,2) if other else (None,None,None,None)
    if oh[3] is not None and oh[3]<bh[3]-.00001:other_covered+=1;continue
    minimum=margin if minimum is None else min(minimum,margin)
    if margin<-.0001:
     exposed+=1;maximum=max(maximum,-margin)
     if len(examples)<40:examples.append({'source_triangle':face_index,'rest_point':list(rp),'body_point':list(bh[0]),'cloak_point':list(ch[0]),'protrusion':-margin})
 return {'samples':counts,'exposed':exposed,'minimum_clearance':minimum,'maximum_protrusion':maximum,'failure_examples':examples,'raw_body_outside_upper_samples':raw_protrusions,'raw_minimum_clearance_without_other_clothes':raw_minimum,'other_actual_clothing_occluded_body_samples':other_covered,'source_boundary_band_excluded':.003,'edge_samples_excluded':edge_skipped,'ROI':{'abs_x_max':.38,'min_y':.20,'z_bounds':bounds}}



# Human没有任何输入变化时才继承原有接触；保留数值而不宣称已经清除。
def compare_human(row, baseline):
    if {name:record['sha256'] for name,record in row['actual_inputs'].items()}!={name:record['sha256'] for name,record in baseline['actual_inputs'].items()}:
        return False
    for name in ['samples','exposed','edge_samples_excluded','other_actual_clothing_occluded_body_samples','raw_body_outside_upper_samples']:
        if row[name]!=baseline[name]:return False
    for name in ['minimum_clearance','raw_minimum_clearance_without_other_clothes']:
        current,old=row[name],baseline[name]
        if current is None or old is None:
            if current is not old:return False
        elif abs(current-old)>.000002:return False
    return True


# 只读实际产物；没有试修参数，也不会调用任一身体或衣物适配函数。
def main(options):
    assembly=load('closed_back_assembly','verify-modular-character-appearance.py')
    arm=load('closed_back_motion','verify-modular-character-arms.py')
    clothing=load('closed_back_components','modular-character-clothing-fit.py')
    catalog=json.loads(options.catalog.read_text())
    bodies={row['character_key']:row for row in catalog['characters']}
    wearables={row['wearable_key']:row for row in catalog['wearables']}
    poses=[(row['motion'],row['frame']) for row in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']]
    baseline=json.loads(options.baseline_report.read_text()) if options.baseline_report else None
    if baseline and baseline['test_sha256']!=sha(__file__):raise ValueError('基线检查器已变化')
    identity=lambda row:(row['body'],row['wearable_key'],row['motion'],row['frame'])
    old_rows={identity(row):row for row in baseline['cases']} if baseline else {}
    report={'fit_applied':False,'mode':'verify-actual-final-GLB','test_sha256':sha(__file__),'catalog_sha256':sha(options.catalog),
            'required_skeleton_clearance':options.minimum_clearance,'requested_bodies':options.body,'cases':[],
            'tools':{name:sha(ROOT/'scripts'/name) for name in ['verify-modular-character-appearance.py','verify-modular-character-arms.py','modular-character-torso-back-fit-blender-test.py','modular-character-clothing-fit.py','asset-pipeline-rules.json']},
            'baseline_report':{'path':str(options.baseline_report),'sha256':sha(options.baseline_report)} if options.baseline_report else None}
    key='upper-rogue-v1'
    for body_key in options.body:
        paths={}
        body,rig,selected,hashes,selection,sources=assembly.load_appearance({'body':body_key,'selection':{'upper':key}},bodies,wearables,options.asset_directory,paths)
        item=wearables[key]
        armor=sources[item['model_asset_key']][item['nodes'][0]]
        original=[vertex.co.copy() for vertex in armor.data.vertices]
        armor.data.calc_loop_triangles()
        polygons={index for component in clothing.mesh_components(armor) if clothing.component_region(component['center'],rig)=='torso' for index in component['faces']}
        domain=[]
        for tri in armor.data.loop_triangles:
            points=[armor.matrix_world@armor.data.vertices[index].co for index in tri.vertices]
            normal=(points[1]-points[0]).cross(points[2]-points[0]).normalized()
            if tri.polygon_index in polygons and normal.y>.45:domain.append(tri.index)
        if not domain:raise ValueError('背向来源衣片域为空')
        base=sources[body['model_asset_key']]
        under=[base[name] for name in body['fixed_nodes']+[node for nodes in body['body_regions'].values() for node in nodes] if name in base and base[name] in selected]
        occluders=[obj for obj in selected if obj not in under and obj is not armor]
        actions=arm.load_actions(bpy,body,hashes,options.asset_directory,paths,poses)
        actual_inputs={name:{'path':paths[name],'sha256':value} for name,value in hashes.items()}
        for motion,frame in poses:
            arm.apply_pose(bpy,rig,body,actions,motion,frame)
            row=focused_check(armor,original,domain,under,occluders,[.72,1.0],64)
            if not row['samples']:raise ValueError('闭面域未执行任何采样')
            row.update(body=body_key,wearable_key=key,motion=motion,frame=frame,actual_inputs=actual_inputs)
            if body_key=='kaykit-skeleton-v1':
                row['status']='passed' if row['exposed']==0 and row['minimum_clearance'] is not None and row['minimum_clearance']>=options.minimum_clearance else 'failed'
            elif baseline:
                prior=old_rows.get(identity(row))
                row['status']='unchanged_baseline_contact' if prior and compare_human(row,prior) else 'failed_human_changed'
            else:row['status']='baseline_contact_recorded'
            report['cases'].append(row)
            print('实际背部闭面检查',body_key,key,motion,frame,row['status'],row['samples'],row['exposed'],row['minimum_clearance'],flush=True)
    skeleton=[row for row in report['cases'] if row['body']=='kaykit-skeleton-v1']
    human=[row for row in report['cases'] if row['body']!='kaykit-skeleton-v1']
    report['summary']={'cases':len(report['cases']),'samples':sum(row['samples'] for row in report['cases']),
                       'skeleton':{'cases':len(skeleton),'samples':sum(row['samples'] for row in skeleton),'exposed':sum(row['exposed'] for row in skeleton),'minimum_clearance':min((row['minimum_clearance'] for row in skeleton if row['minimum_clearance'] is not None),default=None)},
                       'human':{'cases':len(human),'samples':sum(row['samples'] for row in human),'retained_contact_samples':sum(row['exposed'] for row in human),'strict_baseline_equal':all(row['status']=='unchanged_baseline_contact' for row in human) if baseline and human else None},
                       'edge_samples_excluded':sum(row['edge_samples_excluded'] for row in report['cases']),
                       'other_actual_clothes_covering_body_samples':sum(row['other_actual_clothing_occluded_body_samples'] for row in report['cases'])}
    passed=all(row['status']=='passed' for row in skeleton) and all(row['status']=='unchanged_baseline_contact' for row in human)
    report['status']=('passed_for_skeleton_scope' if not human else ('passed_for_human_no_regression_scope' if not skeleton else 'passed_for_skeleton_fix_and_human_no_regression')) if passed else 'failed_or_baseline_only'
    report['limits']=['This checks source-supported waist/back main surfaces (rest |X|<.38, Y>.20, .72<Z<1.0), excluding a 3mm source mesh boundary band. It does not claim zero intersections at neck interfaces or all continuous frames.',
                      'Actual selected clothing is included in first-hit evaluation. Raw body-versus-upper overlap and body hidden by another real garment are reported separately.',
                      'Human baseline contacts are retained and numerically compared, not declared repaired or invisible by this geometry tool. Independent human visual review is required.',
                      'Source attribute preservation and seam integrity are established by separate structural evidence; this no-fit test does not claim them merely because it does not mutate input files.']
    options.report.parent.mkdir(parents=True,exist_ok=True)
    options.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 0 if passed else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--asset-directory',type=Path,required=True)
    parser.add_argument('--body','--bodies',nargs='+',choices=['kaykit-medium-v1','kaykit-skeleton-v1'],default=['kaykit-medium-v1','kaykit-skeleton-v1'])
    parser.add_argument('--baseline-report',type=Path)
    parser.add_argument('--minimum-clearance',type=float,default=.003)
    parser.add_argument('--report',type=Path,required=True)
    options=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    raise SystemExit(main(options))
