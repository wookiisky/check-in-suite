"""用已核实源件整理首批营地GLB与实际模型缩略图；在Blender中执行。"""
import bpy,json,math,hashlib,shutil,argparse,sys,importlib.util
from pathlib import Path
from mathutils import Vector,Matrix
ROOT=Path(__file__).resolve().parents[1];OUTPUT=ROOT/'.local/asset-pipeline/camp';DIRECTORY=OUTPUT/'work';BUILTIN=OUTPUT/'internal/assets/builtin'

# 把源模型的世界变换烘焙进网格，再按明确的首件尺寸整理。
def import_part(part):
 before=set(bpy.data.objects)
 bpy.ops.import_scene.gltf(filepath=str(ROOT/part['source']))
 meshes=[obj for obj in bpy.data.objects if obj not in before and obj.type=='MESH']
 transform=Matrix.Translation(Vector((part['position_m'][0],-part['position_m'][2],part['position_m'][1])))@Matrix.Rotation(math.radians(part['rotation_y_degrees']),4,'Z')@Matrix.Diagonal((part['scale'][0],part['scale'][2],part['scale'][1],1))
 bb=bounds(meshes)
 base=Matrix.Identity(4) if part.get('preserve_source_origin') else Matrix.Translation(Vector((-(bb[0][0]+bb[0][1])/2,-(bb[1][0]+bb[1][1])/2,-bb[2][0])))
 for mesh in meshes:
  world=mesh.matrix_world.copy();mesh.parent=None;mesh.data.transform(transform@base@world);mesh.matrix_world=Matrix.Identity(4)
  for material in mesh.data.materials:
   style=part.get('material_style',{}).get(material.name.split('.')[0])
   if not style:continue
   material.metallic=style.get('metallic',material.metallic);material.roughness=style.get('roughness',material.roughness)
   if 'base_color' in style:material.diffuse_color=style['base_color']
   if 'double_sided' in style:material.use_backface_culling=not style['double_sided']
   if material.use_nodes:
    for node in material.node_tree.nodes:
     if node.type=='BSDF_PRINCIPLED':
      node.inputs['Metallic'].default_value=material.metallic;node.inputs['Roughness'].default_value=material.roughness
      if 'base_color' in style:node.inputs['Base Color'].default_value=style['base_color']
 if part.get('repair_leaf_normals'):
  import bmesh
  for mesh in meshes:
   bm=bmesh.new();bm.from_mesh(mesh.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.000001);bm.normal_update()
   indices={i for i,m in enumerate(mesh.data.materials) if m.name.split('.')[0]=='leafsGreen'}
   for face in bm.faces:
    if face.material_index in indices and face.normal.z<0:face.normal_flip()
   bm.normal_update();bm.to_mesh(mesh.data);bm.free();mesh.data.update()
   if mesh.data.has_custom_normals:mesh.data.normals_split_custom_set([(0,0,0)]*len(mesh.data.loops))
   for polygon in mesh.data.polygons:polygon.use_smooth=False
 return meshes

# 在实际变换后的顶点上计算边界，包含所有模型构件。
def bounds(meshes):
 points=[obj.matrix_world@vertex.co for obj in meshes for vertex in obj.data.vertices]
 return [[min(point[i] for point in points),max(point[i] for point in points)] for i in range(3)]

# 相机按实际投影边界留白；统一三分之四前视角并保留透明背景。
def render_thumbnail(meshes,path):
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.use_denoising=True
 scene.render.resolution_x=scene.render.resolution_y=384;scene.render.resolution_percentage=100
 scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.film_transparent=True;scene.world.color=(.35,.35,.35)
 bb=bounds(meshes);center=Vector(tuple((a+b)/2 for a,b in bb))
 camera_data=bpy.data.cameras.new('CandidateCamera');camera_data.type='ORTHO';camera=bpy.data.objects.new('CandidateCamera',camera_data);scene.collection.objects.link(camera);scene.camera=camera
 camera.location=center+Vector((4,-7,4));camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler();rotation=camera.rotation_euler.to_matrix();horizontal,vertical=rotation.col[0],rotation.col[1]
 corners=[obj.matrix_world@Vector(c) for obj in meshes for c in obj.bound_box]
 width=max((point-center).dot(horizontal) for point in corners)-min((point-center).dot(horizontal) for point in corners);height=max((point-center).dot(vertical) for point in corners)-min((point-center).dot(vertical) for point in corners)
 camera_data.ortho_scale=max(width,height)*1.18
 for offset,power,size in [((4,-6,7),900,6),((-4,-2,3),500,5)]:
  data=bpy.data.lights.new('CandidateLight','AREA');data.energy=power;data.size=size;light=bpy.data.objects.new('CandidateLight',data);scene.collection.objects.link(light);light.location=center+Vector(offset);light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
 scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)


# 标线与球是明确尺寸的项目原创网格，不冒充第三方资源。
def authored_model(kind):
 meshes=[]
 if kind=='sports-area':
  white=bpy.data.materials.new('CourtPaint');white.diffuse_color=(.96,.96,.89,1)
  for name,position,size in [('left',(-1.2,0,.004),(.025,2.4,.008)),('right',(1.2,0,.004),(.025,2.4,.008)),('front',(0,-1.2,.004),(2.4,.025,.008)),('back',(0,1.2,.004),(2.4,.025,.008)),('center',(0,0,.004),(.025,2.4,.008))]:
   bpy.ops.mesh.primitive_cube_add(size=1,location=position);obj=bpy.context.object;obj.name='court_'+name;obj.dimensions=size;bpy.ops.object.transform_apply(location=True,rotation=True,scale=True);obj.data.materials.append(white);meshes.append(obj)
  bpy.ops.mesh.primitive_torus_add(major_segments=40,minor_segments=6,location=(0,0,.005),major_radius=.4,minor_radius=.01);obj=bpy.context.object;obj.name='court_circle';obj.data.materials.append(white);meshes.append(obj)
 elif kind=='ball':
  orange=bpy.data.materials.new('BallOrange');orange.diffuse_color=(.95,.27,.06,1)
  ivory=bpy.data.materials.new('BallIvory');ivory.diffuse_color=(.96,.94,.85,1)
  bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=.13);obj=bpy.context.object;obj.data.materials.append(orange);obj.data.materials.append(ivory)
  for polygon in obj.data.polygons:polygon.material_index=1 if abs(polygon.center.z)<.025 else 0
  meshes.append(obj)
 return meshes

# 来源许可文件既用于元数据生成，也必须进入候选依赖。
def source_metadata_path(part):
 pack = next(name for name in ['furniture', 'nature', 'survival'] if '/kenney-' + name + '/' in part['source'])
 return ROOT / '.local/3d-sources' / ('kenney-' + pack) / 'source.json'


# 本地候选不写生产目录；占地向外取整，不能以模型中心代替完整边界。
def prepare(item):
 bpy.ops.wm.read_factory_settings(use_empty=True)
 scene=bpy.context.scene
 if scene.world is None:scene.world=bpy.data.worlds.new('CandidateWorld')
 meshes=[]
 if item.get('authored'):meshes=authored_model(item['authored'])
 for part in item['parts']:meshes.extend(import_part(part))
 bb=bounds(meshes);shift=Vector((0,0,0)) if item.get('preserve_model_origin') else Vector((-(bb[0][0]+bb[0][1])/2,-(bb[1][0]+bb[1][1])/2,-(bb[2][0]+bb[2][1])/2 if item.get('anchor_kind')=='center' else -bb[2][0]))
 for index,mesh in enumerate(meshes):mesh.data.transform(Matrix.Translation(shift));mesh.name=item['key'].replace('-','_')+'_'+str(index)
 bb=bounds(meshes);gltf=[bb[0],bb[2],[-bb[1][1],-bb[1][0]]]
 bpy.ops.object.select_all(action='DESELECT')
 for mesh in meshes:mesh.select_set(True)
 model=BUILTIN/(item['key']+'.glb')
 if item.get('pass_through'):shutil.copyfile(ROOT/item['parts'][0]['source'],model)
 else:bpy.ops.export_scene.gltf(filepath=str(model),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_animations=False,export_extras=False)
 thumbnail=BUILTIN/(item['key']+'-thumbnail.png') if item.get('thumbnail',True) else DIRECTORY/'thumbnails'/(item['key']+'.png');render_thumbnail(meshes,thumbnail)
 source_records=[]
 for part in item['parts']:
  if part.get('provenance'):
   source_records.append({**part,**part['provenance'],'source_file_sha256':hashlib.sha256((ROOT/part['source']).read_bytes()).hexdigest()})
  else:
   source_meta=json.loads(source_metadata_path(part).read_text())
   source_records.append(dict(**part,provider='Kenney',license='CC0-1.0',source_url=source_meta['url'],source_archive_sha256=source_meta['archive_sha256'],source_file_sha256=hashlib.sha256((ROOT/part['source']).read_bytes()).hexdigest()))
 width=math.ceil((gltf[0][1]-gltf[0][0])*100);depth=math.ceil((gltf[2][1]-gltf[2][0])*100)
 record={**{key:value for key,value in item.items() if key!='parts'},'sources':source_records,'model_file':str(model.relative_to(OUTPUT)),'thumbnail_file':str(thumbnail.relative_to(OUTPUT)),'model_url_plan':'/api/v1/assets/'+item['key'],'thumbnail_key_plan':item['key']+'-thumbnail','runtime_transform':{'scale':[1,1,1],'anchor_m':[0,0,0],'rotation_y_degrees':0},'bounds_m':gltf,'dimensions_m':[b-a for a,b in gltf],'placement_cm':{'width':width+10,'depth':depth+10,'full_model_width':width,'full_model_depth':depth},'walk_obstacle_cm':{'min_x':math.floor(gltf[0][0]*100),'max_x':math.ceil(gltf[0][1]*100),'min_z':math.floor(gltf[2][0]*100),'max_z':math.ceil(gltf[2][1]*100)} if item['walk_obstacle'] else None,'model_sha256':hashlib.sha256(model.read_bytes()).hexdigest(),'thumbnail_sha256':hashlib.sha256(thumbnail.read_bytes()).hexdigest(),'interactive':None,'composition_to_anchor_m':[shift.x,shift.z,-shift.y]}
 if item['key']=='camp-tree-v1':
  points=[vertex.co for obj in meshes for vertex in obj.data.vertices if vertex.co.z<.7]
  record['walk_obstacle_cm']={'min_x':math.floor(min(v.x for v in points)*100),'max_x':math.ceil(max(v.x for v in points)*100),'min_z':math.floor(-max(v.y for v in points)*100),'max_z':math.ceil(-min(v.y for v in points)*100)}
 if item['key'] in ['camp-reading-desk-v1','camp-bench-v1']:
  front=gltf[2][1]
  record['interactive']={'activity':'read','approach_xz_cm':[0,math.ceil(front*100)+45],'suggested_facing_quarter_turns':2 if item['key']=='camp-reading-desk-v1' else 0,'actor_seat_xz_cm':[0,round((.85-shift.y)*100) if item['key']=='camp-reading-desk-v1' else 5],'seat_pose':'Sit_Chair_Idle','verification':'交互点仅为当前模型尺度建议，正式寻路与人物坐姿还需P3集成核对'}
 if record['interactive']:
  interaction=record['interactive'];seat_mesh=meshes[-1] if item['key']=='camp-reading-desk-v1' else meshes[0];seat_mesh.data.update();groups={}
  for polygon in seat_mesh.data.polygons:
   if polygon.normal.z>.9 and .2<polygon.center.z<.7:
    level=round(polygon.center.z,3);group=groups.setdefault(level,{'area':0,'vertices':[]});group['area']+=polygon.area;group['vertices'].extend(seat_mesh.data.vertices[index].co.copy() for index in polygon.vertices)
  level,surface=max(groups.items(),key=lambda pair:pair[1]['area']);points=surface['vertices'];seat=[round((min(v.x for v in points)+max(v.x for v in points))*50),round(-(min(v.y for v in points)+max(v.y for v in points))*50)]
  interaction['seat_xz_cm']=seat;interaction.pop('actor_seat_xz_cm',None);theta=interaction['suggested_facing_quarter_turns']*math.pi/2
  interaction['actor_root_xz_cm']=[seat[0]+round(32.666*math.sin(theta)),seat[1]+round(32.666*math.cos(theta))]
  interaction['actor_root_height_cm']=round(level*100-36.28136)
  interaction['seat_height_cm']=round(level*100)
  interaction['seat_surface_evidence']={'method':'largest upward horizontal surface within known seat height band','actual_height_m':level,'area_m2':surface['area']}
  interaction['pose_action']='read';interaction['pose_clip']='Read';interaction['pose_reference_file']='.local/3d-sources/living-actions/living.glb';interaction['pose_reference_sha256']=hashlib.sha256((ROOT/'.local/3d-sources/living-actions/living.glb').read_bytes()).hexdigest()
  interaction['pose_anchor_note']='正式人物Read在0.5秒实测，保留Sit_Chair_Idle髋部/根轨道，骨盆相对actor根向后约32.7cm。根点已按朝向补偿；高度依据实际座面与当前默认下装接触边界。过渡/其他外观仍须P3运行时核对。'
 if item.get('interaction_pose') and record['interactive']:record['interactive'].update(item['interaction_pose'])
 if item['key'] in ['camp-flowers-v1','camp-sports-area-v1']:record['placement_allows_soft_overlap']=True
 if item['key']=='camp-ball-v1':record['placement_allows_soft_overlap']=False;record['placement_blocks_solids']=True
 if item.get('authored'):record['sources']=[{'provider':'本项目原创建模','construction':item['authored'],'license':'project-owned'}]
 if item['region']=='activity-prop':
  record['placement_cm']=None;record['inventory']=False;record['runtime_transform']['anchor_kind']='attachment' if item.get('preserve_model_origin') else 'center';record['runtime_transform']['center_height_on_ground_m']=-gltf[1][0]
 else:record['runtime_transform']['anchor_kind']='ground'
 if item['key']=='camp-reading-book-v1':record['page_front_normal_local']='+Z'
 if item['key']=='camp-ball-v1':record['interactive']={'activity':'ball','approach_xz_cm':[0,50],'suggested_facing_quarter_turns':2,'pose_action':'play','visual_center_cm':[0,13,0],'verification':'摆放时ground原点，运动球旋转前须处理球心13cm偏移；performing隐藏静态球'}
 record['source_part_normalization']='各源件先以XZ边界中心/最低点归一后组合；preserve_source_origin的同套构件保留原配合原点'
 bpy.ops.wm.save_as_mainfile(filepath=str(DIRECTORY/'evidence'/(item['key']+'.blend')))
 return record


# 房屋卡片使用既有四件正式构件，位置与已验收的6米房屋相同。
def house_thumbnail(config):
 bpy.ops.wm.read_factory_settings(use_empty=True);bpy.context.scene.world=bpy.data.worlds.new('CampHouseWorld');meshes=[]
 def part(key,position,rotation=0,scale=(1,1,1)):
  meshes.extend(import_part(dict(source='internal/assets/builtin/'+key+'.glb',position_m=position,rotation_y_degrees=rotation,scale=list(scale),preserve_source_origin=True)))
 for x in [-2,0,2]:
  for z in [-2,0,2]:part('camp-floor-v1',[x,0,z])
 for offset in [-2,0,2]:
  part('camp-wall-v1',[offset,.1,-3],90);part('camp-doorway-v1' if offset==0 else 'camp-wall-v1',[offset,.1,3],90);part('camp-wall-v1',[3,.1,offset]);part('camp-wall-v1',[-3,.1,offset])
 part('camp-roof-v1',[0,2.5,0],scale=(3.04,1,3.04));path=BUILTIN/(config['key']+'.png');render_thumbnail(meshes,path)
 return {**config,'file':str(path.relative_to(OUTPUT)),'source_model_keys':['camp-floor-v1','camp-wall-v1','camp-doorway-v1','camp-roof-v1'],'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}

# 原始配置只读，所有产物与目录变更在同一候选中完成。
def main(arguments=None):
 global OUTPUT, DIRECTORY, BUILTIN
 parser = argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output', type=Path, default=OUTPUT)
 if arguments is None:
  arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
 args = parser.parse_args(arguments)
 specification = importlib.util.spec_from_file_location('camp_candidate', Path(__file__).with_name('asset-pipeline-candidate.py'))
 helper = importlib.util.module_from_spec(specification)
 specification.loader.exec_module(helper)
 OUTPUT = helper.validate_candidate_output(ROOT, args.output)
 if (OUTPUT / 'candidate.json').exists():
  raise ValueError('candidate output already finalized; choose a new output directory')
 DIRECTORY = OUTPUT / 'work'
 BUILTIN = OUTPUT / 'internal/assets/builtin'
 BUILTIN.mkdir(parents=True, exist_ok=True)
 baseline = helper.capture_baseline(ROOT)
 config_path = ROOT / 'internal/assets/camp-source-manifest.json'
 config = json.loads(config_path.read_text())
 for directory in [DIRECTORY, DIRECTORY / 'thumbnails', DIRECTORY / 'evidence']:
  directory.mkdir(parents=True, exist_ok=True)
 dependency_paths = [Path(__file__), config_path]
 dependency_paths.extend(ROOT / part['source'] for item in config['items'] for part in item['parts'])
 dependency_paths.extend(ROOT / entry['source'] for entry in config['extra_assets'])
 dependency_paths.extend(source_metadata_path(part) for item in config['items'] for part in item['parts'] if not part.get('provenance'))
 if any(item['key'] in ['camp-reading-desk-v1', 'camp-bench-v1'] for item in config['items']):
  dependency_paths.append(ROOT / '.local/3d-sources/living-actions/living.glb')
 dependency_paths = [path for source in dependency_paths for path in helper.source_dependencies(source)]
 dependencies = helper.capture_dependencies(ROOT, dependency_paths)
 records = [prepare(item) for item in config['items']]
 entries = []
 for item in records:
  source = item['sources'][0]
  url = source.get('source_url', 'project:check-in-suite/scripts/prepare-camp-assets.py')
  license = source.get('license', 'project-owned')
  key = item['key']
  entries.append(dict(key=key, name=item['name'], kind='model', url='/api/v1/assets/' + key, format='glb', source_url=url, license=license))
  if item.get('thumbnail', True):
   entries.append(dict(key=key + '-thumbnail', name=item['name'], kind='island', url='/api/v1/assets/' + key + '-thumbnail', format='png', source_url=url, license=license, **({'free': True} if item.get('free') else {})))
 for extra in config['extra_assets']:
  path = BUILTIN / (extra['key'] + '.glb')
  shutil.copyfile(ROOT / extra['source'], path)
  entries.append({key: value for key, value in extra.items() if key != 'source'} | dict(url='/api/v1/assets/' + extra['key'], format='glb'))
 house = house_thumbnail(config['house_thumbnail'])
 entries.append({**config['house_thumbnail'], 'url': '/api/v1/assets/' + house['key'], 'format': 'png'})
 catalog = json.loads((ROOT / 'internal/assets/builtin/catalog.json').read_text())
 keys = {item['key'] for item in entries}
 catalog = [item for item in catalog if item['key'] not in keys] + entries
 (BUILTIN / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
 metadata = dict(items=records, house_thumbnail=house, extra_assets=config['extra_assets'])
 (OUTPUT / 'internal/assets/camp-asset-metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
 helper.finalize_candidate(ROOT, OUTPUT, 'camp', baseline=baseline, dependencies=dependencies)


if __name__ == '__main__':
 main()
