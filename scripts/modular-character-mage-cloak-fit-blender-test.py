"""真实来源肩片与完整身体闭体的离线回归；可选既有衣物矩阵，省略即只验证。"""
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
ROOT=Path(__file__).resolve().parents[1]
KEY='kaykit-legacy-skeleton-mage-back-cloak'
# 只加载现有组装和适配函数，不执行这些脚本的命令行。
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
assembly=load('mage_actual_assembly','verify-modular-character-appearance.py')
arm=load('mage_actual_arm','verify-modular-character-arms.py')
clothing=load('mage_actual_clothing','modular-character-clothing-fit.py')
attrs=load('mage_actual_attrs','modular-character-back-fit-blender-test.py')
# 报告绑定本次实际读取的文件字节。
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
# 所有碰撞均使用当前真实姿态求值后的面。
def surface(ob):
    ev=ob.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=ev.to_mesh();mesh.calc_loop_triangles();points=[ev.matrix_world@v.co for v in mesh.vertices];triangles=[tuple(t.vertices) for t in mesh.loop_triangles];ev.to_mesh_clear();return points,triangles
# 跨部位按同一来源位置焊接，先找真实闭体；不向分区开口添加任何面。
def body_components(objects):
    keys={};rest=[];faces=[];links=[]
    for ob in objects:
        ob.data.calc_loop_triangles();mapping=[]
        for v in ob.data.vertices:
            p=ob.matrix_world@v.co;k=tuple(round(float(c),5) for c in p)
            if k not in keys:keys[k]=len(rest);rest.append(p)
            mapping.append(keys[k])
        links.append((ob,mapping))
        faces.extend(tuple(mapping[i] for i in t.vertices) for t in ob.data.loop_triangles)
    adjacency={}
    for i,t in enumerate(faces):
        for a,b in zip(t,t[1:]+t[:1]):adjacency.setdefault(tuple(sorted((a,b))),[]).append(i)
    remaining=set(range(len(faces)));components=[]
    while remaining:
        pending=[min(remaining)];ids=set()
        while pending:
            f=pending.pop()
            if f not in remaining:continue
            remaining.remove(f);ids.add(f);t=faces[f]
            pending.extend(n for a,b in zip(t,t[1:]+t[:1]) for n in adjacency[tuple(sorted((a,b)))] if n in remaining)
        counts=Counter();directed=Counter()
        for f in ids:
            t=faces[f]
            for a,b in zip(t,t[1:]+t[:1]):counts[tuple(sorted((a,b)))]+=1;directed[(a,b)]+=1
        components.append({'faces':[faces[i] for i in sorted(ids)],'indices':sorted({i for f in ids for i in faces[f]}),'closed':all(c==2 for c in counts.values()),'edge_incidence':dict(Counter(counts.values())),'oriented':all(directed[(a,b)]==directed[(b,a)] for a,b in counts)})
    return rest,links,components
# 奇偶测试只用于真实闭体，射线从面外重新出发以避免同面重复命中。
def inside(tree,point):
    origin=point.copy();direction=Vector((1,.31,.27)).normalized();count=0
    for _ in range(128):
        hit=tree.ray_cast(origin,direction,5)
        if hit[0] is None:break
        count+=1;origin=hit[0]+direction*.00001
    return count%2==1
# 源域以固定REST肩片选面，采样密度与fit无关，完整保留两侧及接缝内点。
def samples(cape):
    cape.data.calc_loop_triangles();domain=[]
    identities=json.loads(opts.domain_reference.read_text())['triangles'];wanted={(t['material'],tuple(tuple(v) for v in t['uv_signature'])) for t in identities};matched=set();layer=cape.data.uv_layers.active
    for tri in cape.data.loop_triangles:
        signature=(cape.data.materials[cape.data.polygons[tri.polygon_index].material_index].name.split('.')[0],tuple(sorted(tuple(round(float(v),5) for v in layer.data[i].uv) for i in tri.loops)))
        if signature not in wanted:continue
        assert signature not in matched,'来源肩片UV身份不唯一'
        matched.add(signature)
        for a in range(1,24):
            for b in range(1,24-a):domain.append((tri.index,tuple(tri.vertices),(a/24,b/24,1-(a+b)/24)))
    assert matched==wanted,'来源肩片有面丢失'
    return domain
p=argparse.ArgumentParser();p.add_argument('--catalog',type=Path,required=True);p.add_argument('--asset-directory',type=Path,required=True);p.add_argument('--adjustments',type=Path);p.add_argument('--report',type=Path,required=True);p.add_argument('--expect-red',action='store_true');p.add_argument('--candidate-output',type=Path);p.add_argument('--camera-records',type=Path,required=True);p.add_argument('--domain-reference',type=Path,required=True)
opts=p.parse_args(sys.argv[sys.argv.index('--')+1:]);catalog=json.loads(opts.catalog.read_text());bodies={x['character_key']:x for x in catalog['characters']};wearables={x['wearable_key']:x for x in catalog['wearables']};poses=[(x['motion'],x['frame']) for x in json.loads((ROOT/'scripts/asset-pipeline-rules.json').read_text())['sampling']['poses']];adjustments=json.loads(opts.adjustments.read_text()) if opts.adjustments else []
report={'tool_sha256':sha(__file__),'catalog_sha256':sha(opts.catalog),'fit_applied':bool(adjustments),'adjustments':adjustments,'inputs':{},'cases':[],'domain':'REST triangle center absX>.15,Y<-.04,Z>1.075;24-way interior barycentric grid;35 source triangles;full welded body components;open components only surface distances','status':'running','domain_reference':{'path':str(opts.domain_reference.resolve()),'sha256':sha(opts.domain_reference)},'human_volume_conclusion':None,'human_status':'needs_visual_review','camera_records':{'path':str(opts.camera_records.resolve()),'sha256':sha(opts.camera_records)},'open_skin_limit':'Human main skin component has source nonmanifold region joins; local signed-surface candidates are reported separately for visual review and never called closed-volume penetration. Frozen Skeleton cameras may be used on Human when same-body camera records are absent; per-case binding is explicit.','validation_scope':'known positive-shoulder Read closed panel >=3mm; both bodies 8 poses frozen source cameras have no isolated true contact island; edge-connected foreground/neck/upper-arm contacts are grouped, not required to be zero'}
camera_rows=[json.loads(x) for x in opts.camera_records.read_text().splitlines()]
for bodykey in bodies:
    paths={};body,rig,selected,hashes,selection,sources=assembly.load_appearance({'body':bodykey,'selection':{'back':KEY}},bodies,wearables,opts.asset_directory,paths);cape=sources[wearables[KEY]['model_asset_key']]['back_cloak'];bodyobjs=[ob for name,ob in sorted(sources[body['model_asset_key']].items()) if name.startswith('body_') and ob in selected];rest,links,components=body_components(bodyobjs);domain=samples(cape);before=attrs.attributes(cape);original=[v.co.copy() for v in cape.data.vertices];others={ob:[v.co.copy() for v in ob.data.vertices] for ob in selected if ob!=cape};operation=clothing.fit_upper_clothing([cape],rig,adjustments) if adjustments else None;after=attrs.attributes(cape);changes=[{'vertex':v.index,'from':list(co),'to':list(v.co),'distance':(v.co-co).length} for v,co in zip(cape.data.vertices,original) if (v.co-co).length>1e-8]
    assert before==after,'源拓扑/UV/材质/权重变化';assert all(v.co==co for ob,ps in others.items() for v,co in zip(ob.data.vertices,ps)),'其他节点变化';assert all(v.co==co for v,co in zip(cape.data.vertices,original) if co.z<=1.02 or abs(co.x)<=.15),'远端或中央领口变化'
    actions=arm.load_actions(bpy,body,hashes,opts.asset_directory,paths,poses);report['inputs'].update({k:{'path':paths[k],'sha256':v} for k,v in hashes.items()});report.setdefault('body_operations',{})[bodykey]={'operation':operation,'changed_vertices':changes,'maximum_displacement':max((x['distance'] for x in changes),default=0),'source_attributes_preserved':True if adjustments else None,'other_nodes_unchanged':True,'lower_and_center_vertices_unchanged_during_test':True,'source_lower_and_center_preserved':True if adjustments else None,'body_component_topology':[{'faces':len(c['faces']),'closed':c['closed'],'oriented':c['oriented'],'edge_incidence':c['edge_incidence']} for c in components]}
    for motion,frame in poses:
        arm.apply_pose(bpy,rig,body,actions,motion,frame);points=[None]*len(rest);gap=0
        for ob,mapping in links:
            ps,ts=surface(ob)
            for index,point in zip(mapping,ps):
                if points[index] is not None:gap=max(gap,(points[index]-point).length)
                points[index]=point
        trees=[]
        for c in components:
            ps=[points[i] for i in c['indices']];bounds=[(min(p[i] for p in ps),max(p[i] for p in ps)) for i in range(3)];trees.append((c,BVHTree.FromPolygons(points,c['faces'],all_triangles=True),bounds))
        scene=[]
        for ob in selected:
            op,ot=surface(ob);scene.append((ob,BVHTree.FromPolygons(op,ot,all_triangles=True),ot))
        camera_case=bodykey+':back:'+KEY+'@back-binding@'+motion+'@frame:'+str(frame)
        camera_matches=[r for r in camera_rows if r['case']==camera_case]
        camerarecord=camera_matches[0] if camera_matches else next(r for r in camera_rows if r['case']=='kaykit-skeleton-v1:back:'+KEY+'@back-binding@'+motion+'@frame:'+str(frame))
        cp,ct=surface(cape);cape_tree=BVHTree.FromPolygons(cp,ct,all_triangles=True);domain_tris={x[0] for x in domain};camera_results=[]
        alltree=BVHTree.FromPolygons(points,[f for c in components for f in c['faces']],all_triangles=True);raw_inside=0;raw_min=1e9;observed_min=1e9;observed_samples=0
        for ti,indices,weights in domain:
            q=sum((cp[i]*w for i,w in zip(indices,weights)),Vector());near=alltree.find_nearest(q);is_inside=any(c['closed'] and all(low-1e-5<=q[i]<=high+1e-5 for i,(low,high) in enumerate(bounds)) and inside(tree,q) for c,tree,bounds in trees);signed=-near[3] if is_inside else near[3];raw_inside+=is_inside;raw_min=min(raw_min,signed)
            if bodykey=='kaykit-skeleton-v1' and motion=='read' and sum(original[i].x for i in indices)/3>.15:
                observed_samples+=1;observed_min=min(observed_min,signed)

        body_set=set(bodyobjs)|{ob for ob in selected if ob.name.startswith('0_face')}
        for image in camerarecord['images']:
            camera=image['camera'];right,up,loc=Vector(camera['right']),Vector(camera['up']),Vector(camera['location']);direction=-Vector(camera['direction']);projected=[((q-loc).dot(right)/camera['ortho_scale']+.5)*256-.5 for q in cp];projected_y=[(.5-(q-loc).dot(up)/camera['ortho_scale'])*256-.5 for q in cp];xmin=max(0,int(min(projected))-2);xmax=min(255,int(max(projected))+3);ymin=max(0,int(min(projected_y))-2);ymax=min(255,int(max(projected_y))+3);cape_mask=set();body_mask=set();exposed={}
            for y in range(ymin,ymax+1):
                for x in range(xmin,xmax+1):
                    origin=loc+right*((x+.5)/256-.5)*camera['ortho_scale']+up*(.5-(y+.5)/256)*camera['ortho_scale'];cloth_hit=cape_tree.ray_cast(origin,direction,10)
                    if cloth_hit[0] is None:continue
                    cape_mask.add((x,y));hits=[]
                    for ob,scene_tree,scene_tris in scene:
                        h=scene_tree.ray_cast(origin,direction,10)
                        if h[0] is None:continue
                        ob.data.calc_loop_triangles();st=ob.data.loop_triangles[h[2]];mat=ob.data.materials[ob.data.polygons[st.polygon_index].material_index]
                        if mat.use_backface_culling and h[1].dot(-direction)<=0:continue
                        hits.append((h[3],ob,h))
                    hits.sort(key=lambda v:v[0])
                    if hits and hits[0][1] in body_set:
                        body_mask.add((x,y));q=cloth_hit[0];is_inside=any(c['closed'] and all(low-1e-5<=q[i]<=high+1e-5 for i,(low,high) in enumerate(bounds)) and inside(tree,q) for c,tree,bounds in trees);surface_signed=(q-alltree.find_nearest(q)[0]).dot(alltree.find_nearest(q)[1]);possible_open_skin_contact=bodykey=='kaykit-medium-v1' and surface_signed<-.0001;exposed[(x,y)]={'possible_open_skin_contact':possible_open_skin_contact,'local_body_surface_signed_distance':surface_signed,'inside_closed_body':is_inside,'triangle':cloth_hit[2],'first_body':hits[0][1].name,'cloth_hit':list(cloth_hit[0]),'gap':cloth_hit[3]-hits[0][0]}
            remaining=set(body_mask);groups=[]
            while remaining:
                pending=[min(remaining)];pixels=set()
                while pending:
                    xy=pending.pop()
                    if xy not in remaining:continue
                    remaining.remove(xy);pixels.add(xy);x,y=xy;pending.extend((x+dx,y+dy) for dx in [-1,0,1] for dy in [-1,0,1] if (dx or dy) and (x+dx,y+dy) in remaining)
                touches=any((x+dx,y+dy) not in cape_mask for x,y in pixels for dx in [-1,0,1] for dy in [-1,0,1] if dx or dy);shoulder=[xy for xy in pixels if exposed[xy]['triangle'] in domain_tris]
                if shoulder:groups.append({'pixels':len(pixels),'shoulder_pixels':len(shoulder),'edge_connected':touches,'bbox':[min(x for x,y in pixels),min(y for x,y in pixels),max(x for x,y in pixels),max(y for x,y in pixels)],'shoulder_details':[{'pixel':xy,**exposed[xy]} for xy in shoulder]})
            camera_results.append({'camera':image['camera_name'],'raster_box':[xmin,ymin,xmax,ymax],'cloak_pixels':len(cape_mask),'first_body_over_cloak_pixels':len(body_mask),'shoulder_groups':groups,'isolated_shoulder_pixels':sum(sum(d['inside_closed_body'] for d in g['shoulder_details']) for g in groups if not g['edge_connected']),'isolated_open_skin_surface_candidate_pixels':sum(sum(d['possible_open_skin_contact'] for d in g['shoulder_details']) for g in groups if not g['edge_connected']),'isolated_foreground_noncontact_pixels':sum(sum(not d['inside_closed_body'] for d in g['shoulder_details']) for g in groups if not g['edge_connected'])})
        report['cases'].append({'body':bodykey,'motion':motion,'frame':frame,'camera_case':camerarecord['case'],'camera_is_same_body':bool(camera_matches),'camera_results':camera_results,'closed_subset_inside':raw_inside,'complete_volume_conclusion':None if bodykey=='kaykit-medium-v1' else 'closed source bone components only','raw_minimum_clearance':raw_min,'observed_positive_shoulder_samples':observed_samples,'observed_positive_shoulder_minimum_clearance':observed_min if observed_samples else None,'max_body_shared_point_gap':gap});print(bodykey,motion,frame,[(r['camera'],r['isolated_shoulder_pixels']) for r in camera_results],flush=True)
    if opts.candidate_output:
        arm.apply_pose(bpy,rig,body,actions,'rest',0);bpy.ops.object.select_all(action='DESELECT');cape.select_set(True);rig.select_set(True);bpy.context.view_layer.objects.active=rig;opts.candidate_output.mkdir(parents=True,exist_ok=True);bpy.ops.export_scene.gltf(filepath=str(opts.candidate_output/(bodykey+'--mage-cloak.glb')),export_format='GLB',use_selection=True,export_animations=False,export_skins=True,export_def_bones=False)
for item in report['inputs'].values():assert sha(item['path'])==item['sha256'],'运行期间素材变化'
fail=[r for r in report['cases'] if any(c['isolated_shoulder_pixels'] for c in r['camera_results']) or (r['observed_positive_shoulder_minimum_clearance'] is not None and r['observed_positive_shoulder_minimum_clearance']<.003)];report['status']='red_reproduced' if opts.expect_red and fail else ('failed' if fail else 'passed_skeleton_scope_human_needs_visual_review');report['summary']={'cases':len(report['cases']),'cameras':sum(len(r['camera_results']) for r in report['cases']),'isolated_open_skin_surface_candidate_pixels':sum(c['isolated_open_skin_surface_candidate_pixels'] for r in report['cases'] for c in r['camera_results']),'isolated_pixels':sum(c['isolated_shoulder_pixels'] for r in report['cases'] for c in r['camera_results']),'failures':len(fail),'raw_closed_component_inside':sum(r['closed_subset_inside'] for r in report['cases']),'observed_positive_shoulder_samples':sum(r['observed_positive_shoulder_samples'] for r in report['cases']),'observed_positive_shoulder_minimum_clearance':min(r['observed_positive_shoulder_minimum_clearance'] for r in report['cases'] if r['observed_positive_shoulder_minimum_clearance'] is not None)};opts.report.parent.mkdir(parents=True,exist_ok=True);opts.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(report['summary']);raise SystemExit(0 if (bool(fail) if opts.expect_red else not fail) else 1)
