"""在 Blender 中把已标注人形整理为同一 Medium 身体、骨架与四槽；原始包不进入发布。"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / 'internal/assets/builtin'
MANIFEST = ROOT / 'internal/assets/provider-character-manifest.json'
CONFIGURATION = ROOT / 'scripts/provider-character-sources.json'


# 固定以实际交付 GLB 与加工规范计算资源版本，不覆盖旧文件身份。
def asset_version(key, data, recipe=None):
    configuration=json.dumps(recipe,sort_keys=True,separators=(',',':')).encode() if recipe is not None else b''
    return key[:68] + '-m-' + hashlib.sha256(data+configuration).hexdigest()[:12]


# 源包内不同文件格式只选择标注的一个模型，原始路径保留在加工记录中。
def resolve_source(spec, packs):
    pack = next(p for p in packs if p['provider'] == spec['provider'] and p['id'] == spec['pack_key'])
    directory = ROOT / pack['directory']
    if spec.get('source_relative_path'):
        return directory / spec['source_relative_path'], pack
    matches = [p for p in directory.rglob(spec['filename']) if 'characters' in [part.lower() for part in p.parts]]
    if len(matches) != 1:
        raise ValueError(f"source must resolve once: {spec['key']}: {matches}")
    return matches[0], pack


# 仅由 Blender 调用；Python 标准库检查可导入上述路径和版本函数。
def import_characters(options):
    import bpy
    import bmesh
    from mathutils import Matrix, Vector
    from mathutils.bvhtree import BVHTree

    config = json.loads(CONFIGURATION.read_text())
    sources = config['sources']
    for extra in ['kenney-character-sources.json', 'legacy-kaykit-character-sources.json']:
        file = ROOT/'scripts'/extra
        if file.exists():
            extra_configuration=json.loads(file.read_text())
            sources.extend([{**extra_configuration.get('profiles',{}).get(source.get('profile'),{}),**source} for source in extra_configuration['sources']])
    source_specs={source['key']:source for source in sources}
    if options.evidence:
        sources=[]
    packs = json.loads((ROOT/'internal/assets/provider-pack-manifest.json').read_text())['packs']
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {'characters': [], 'assets': []}
    entries = {entry['definition']['character_key']: entry for entry in previous['characters'] if entry.get('status') == 'imported'}
    assets = {asset['key']: asset for asset in previous['assets']}
    failures = []
    base = json.loads((ROOT/'internal/character/character-catalog.json').read_text())['characters'][0]
    seams = config['seams']

    # 真实网格范围用于缩略图构图和统一身体证据。
    def bounds(objects):
        points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
        return [(min(point[i] for point in points), max(point[i] for point in points)) for i in range(3)]

    # 删除未选择的实际面，同时保持UV、顶点组和蒙皮权重。
    def select_faces(source, name, predicate):
        obj = source.copy()
        obj.data = source.data.copy()
        obj.name = name
        bpy.context.collection.objects.link(obj)
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        layer = mesh.loops.layers.uv.active
        bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if not predicate(face, layer)], context='FACES')
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.to_mesh(obj.data)
        mesh.free()
        return obj

    # 统一截面切开并封口，新点插值保留原有蒙皮。
    def clip(obj, axis, value, positive):
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        normal = Vector((0, 0, 0))
        normal[axis] = 1
        result = bmesh.ops.bisect_plane(mesh, geom=list(mesh.verts)+list(mesh.edges)+list(mesh.faces), plane_co=normal*value, plane_no=normal, dist=0.000001, clear_inner=positive, clear_outer=not positive)
        edges = [edge for edge in result['geom_cut'] if isinstance(edge, bmesh.types.BMEdge) and edge.is_boundary]
        if edges:
            bmesh.ops.holes_fill(mesh, edges=edges, sides=0)
        bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_faces], context='VERTS')
        mesh.normal_update()
        mesh.to_mesh(obj.data)
        mesh.free()
        return obj

    # 衣服与下装、鞋口共用已确定的接口尺寸，替换时不会留下不同连接宽度。
    def shape_seam(obj, height, radius_x, radius_y, center_x=0):
        for vertex in obj.data.vertices:
            distance = abs(vertex.co.z-height)
            if distance > 0.075:
                continue
            x, y = vertex.co.x-center_x, vertex.co.y
            radius = math.hypot(x/radius_x, y/radius_y)
            if radius < 0.000001:
                continue
            amount = (1-distance/0.075)**2
            vertex.co.x = center_x+x*((1-amount)+amount/radius)
            vertex.co.y = y*((1-amount)+amount/radius)

    # 合并一个槽的左右部件，空源件被移除而不是交付空网格。
    def join(objects, name):
        nonempty = [obj for obj in objects if len(obj.data.polygons)]
        for obj in set(objects)-set(nonempty):
            bpy.data.objects.remove(obj, do_unlink=True)
        if not nonempty:
            raise ValueError(f'empty prepared part: {name}')
        bpy.ops.object.select_all(action='DESELECT')
        for obj in nonempty:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = nonempty[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = name
        obj.data.name = name+'_mesh'
        return obj

    # 根据源与目标每根骨骼的真实rest矩阵变换顶点，不能只改变角色根scale。
    def normalize_mesh(obj, source_rig, target_rig, bone_map, rigid_bone=None):
        if not obj.vertex_groups and rigid_bone:
            obj.vertex_groups.new(name=rigid_bone).add(list(range(len(obj.data.vertices))),1,'REPLACE')
        if not any(modifier.type == 'ARMATURE' for modifier in obj.modifiers):
            obj.modifiers.new(name='StandardRig',type='ARMATURE').object=target_rig
        transforms = {}
        for group in obj.vertex_groups:
            source_name = group.name
            target_name = bone_map.get(source_name, source_name)
            if source_name not in source_rig.data.bones or target_name not in target_rig.data.bones:
                raise ValueError(f'unmapped source bone: {source_name}')
            source_bind = source_rig.matrix_world @ source_rig.data.bones[source_name].matrix_local
            target_bind = target_rig.matrix_world @ target_rig.data.bones[target_name].matrix_local
            transforms[group.index] = (target_rig.matrix_world.inverted() @ target_bind @ source_bind.inverted() @ obj.matrix_world)
        for vertex in obj.data.vertices:
            total = sum(group.weight for group in vertex.groups)
            if total <= 0:
                raise ValueError(f'unweighted source vertex: {obj.name}:{vertex.index}')
            original = vertex.co.copy()
            vertex.co = sum(((transforms[group.group] @ original)*(group.weight/total) for group in vertex.groups),Vector((0,0,0)))
        for group in obj.vertex_groups:
            group.name = bone_map.get(group.name, group.name)
        obj.parent = target_rig
        obj.parent_type = 'OBJECT'
        obj.parent_bone = ''
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = Matrix.Identity(4)
        for modifier in obj.modifiers:
            if modifier.type == 'ARMATURE':
                modifier.object = target_rig

    # 角色与衣服缩略图均渲染交付网格，无示意模型或占位图片。
    def render(objects, path):
        all_meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
        for obj in all_meshes:
            obj.hide_render = obj not in objects
        scene = bpy.context.scene
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = 8
        scene.cycles.use_denoising = True
        scene.render.resolution_x = scene.render.resolution_y = 256
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.film_transparent = True
        if scene.world is None:
            scene.world = bpy.data.worlds.new('CharacterWorld')
        scene.world.color = (.5, .5, .5)
        bb = bounds(objects)
        center = Vector(tuple((a+b)/2 for a,b in bb))
        camera_data = bpy.data.cameras.new('PreviewCamera')
        camera_data.type = 'ORTHO'
        camera = bpy.data.objects.new('PreviewCamera', camera_data)
        scene.collection.objects.link(camera)
        scene.camera = camera
        camera.location = center+Vector((3, -7, 3))
        camera.rotation_euler = (center-camera.location).to_track_quat('-Z', 'Y').to_euler()
        rotation = camera.rotation_euler.to_matrix()
        horizontal, vertical = rotation.col[0], rotation.col[1]
        corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
        width = max(point.dot(horizontal) for point in corners)-min(point.dot(horizontal) for point in corners)
        height = max(point.dot(vertical) for point in corners)-min(point.dot(vertical) for point in corners)
        camera_data.ortho_scale = max(width, height)*1.15
        lights = []
        for location, energy, size in [((3,-4,6),600,5),((-4,-2,3),250,4),((0,4,5),400,4)]:
            data = bpy.data.lights.new('PreviewLight', 'AREA')
            data.energy, data.size = energy, size
            light = bpy.data.objects.new('PreviewLight', data)
            scene.collection.objects.link(light)
            light.location = Vector(location)
            light.rotation_euler = (center-light.location).to_track_quat('-Z','Y').to_euler()
            lights.append(light)
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        for obj in lights+[camera]:
            bpy.data.objects.remove(obj, do_unlink=True)
        for obj in all_meshes:
            obj.hide_render = False

    for spec in sources:
        if options.only and spec['key'] not in options.only:
            continue
        if not options.force and spec['key'] in entries:
            continue
        try:
            if spec.get('normalization',{}).get('head_envelope_verified') is False:
                raise ValueError('head envelope and shared hairstyle geometry are not verified; source stays pending')
            source, pack = resolve_source(spec, packs)
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=str(ROOT/config['canonical_model']))
            rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
            rig.animation_data_clear()
            rig.data.pose_position = 'REST'
            canonical_names = {bone.name for bone in rig.data.bones}
            canonical_matrices = {bone.name: bone.matrix_local.copy() for bone in rig.data.bones}
            canonical_parts={obj.name:obj for obj in bpy.data.objects if obj.type == 'MESH'}
            canonical_face_top=max(vertex.co.z for vertex in canonical_parts['body_head'].data.vertices)
            head_surfaces=[]
            canonical_head_points=[]
            for name in ['body_head','body_scalp']:
                mesh=canonical_parts[name].data
                points=[vertex.co.copy() for vertex in mesh.vertices]
                head_surfaces.append(BVHTree.FromPolygons(points,[tuple(face.vertices) for face in mesh.polygons]))
                canonical_head_points.extend(points)
            canonical_head_bounds=[(min(point[axis] for point in canonical_head_points),max(point[axis] for point in canonical_head_points)) for axis in range(3)]
            keep = [canonical_parts[name] for name in ['body_scalp','body_torso','body_arms','body_legs','body_feet']]
            reference_parts=[canonical_parts[name] for name in ['body_head','body_hands','lower_rogue','shoes_rogue']]
            for obj in list(bpy.data.objects):
                if obj.type == 'MESH' and obj not in keep+reference_parts:
                    bpy.data.objects.remove(obj, do_unlink=True)
            before = set(bpy.data.objects)
            if source.suffix.lower() == '.fbx':
                bpy.ops.import_scene.fbx(filepath=str(source))
            else:
                bpy.ops.import_scene.gltf(filepath=str(source))
            imported = set(bpy.data.objects)-before
            source_rig = next((obj for obj in imported if obj.type == 'ARMATURE'), None)
            if source_rig is not None:
                source_rig.animation_data_clear()
                source_rig.data.pose_position = 'REST'
            bpy.context.view_layer.update()
            support_material=spec.get('support_material')
            if support_material:
                source_meshes={obj.name:obj for obj in imported if obj.type=='MESH'}
                matching=[material for name in support_material['nodes'] for material in source_meshes[name].data.materials if material and material.name.split('.')[0]==support_material['material']]
                if not matching:
                    raise ValueError('reviewed source support material missing')
                for region in support_material['regions']:
                    obj=canonical_parts['body_'+region]
                    obj.data.materials.clear()
                    obj.data.materials.append(matching[0])
                    for polygon in obj.data.polygons:
                        polygon.material_index=0
            normalization_evidence={}
            if source_rig is None or spec.get('normalization',{}).get('strategy'):
                import importlib.util
                module_spec=importlib.util.spec_from_file_location('provider_character_binding',ROOT/'scripts/provider-character-binding.py')
                binding=importlib.util.module_from_spec(module_spec)
                module_spec.loader.exec_module(binding)
                parts,spec,normalization_evidence=binding.bind_parts(bpy,bmesh,rig,imported,spec,canonical_parts)
            else:
                requested=set(spec['head_nodes']+spec.get('hair_nodes',[])+spec.get('upper_nodes',[]))
                for field,default in [('body_nodes','_Body'),('left_arm_nodes','_ArmLeft'),('right_arm_nodes','_ArmRight'),('left_leg_nodes','_LegLeft'),('right_leg_nodes','_LegRight')]:
                    requested.update(spec.get(field,[spec['prefix']+default]))
                parts = {obj.name:obj for obj in imported if obj.type == 'MESH' and obj.name in requested}
                for obj in parts.values():
                    rigid_bone = 'head' if obj.name in spec.get('hair_nodes',[]) else 'chest' if obj.name in spec.get('upper_nodes',[]) else None
                    normalize_mesh(obj, source_rig, rig, spec.get('bone_map',{}),rigid_bone)
            source_head_bounds=None
            if spec.get('partition_scalp'):
                source_head=[parts[name] for name in spec['head_nodes']]
                source_head_bounds=[(min(vertex.co[axis] for obj in source_head for vertex in obj.data.vertices),max(vertex.co[axis] for obj in source_head for vertex in obj.data.vertices)) for axis in range(3)]
                # 只收回超出标准头部的范围，不放大较小脸型，也不改变骨架与身体。
                for axis,((low,high),(standard_low,standard_high)) in enumerate(zip(source_head_bounds,canonical_head_bounds)):
                    target_low,target_high=max(low,standard_low),min(high,standard_high)
                    for obj in source_head:
                        for vertex in obj.data.vertices:
                            vertex.co[axis]=target_low+(vertex.co[axis]-low)*(target_high-target_low)/(high-low)
            for name in ['body_head','body_hands']:
                bpy.data.objects.remove(canonical_parts[name],do_unlink=True)
            prefix = spec['prefix']
            head_parts = []
            scalp_parts = []
            hair_parts = [parts[name] for name in spec.get('hair_nodes',[])]
            face_hair_disjoint = True
            for name in spec['head_nodes']:
                original = parts[name]
                if 'hair_head_above' in spec:
                    face = clip(select_faces(original, 'face_'+name, lambda face,uv:True),2,spec['hair_head_above'],False)
                    hair = clip(select_faces(original, 'hair_'+name, lambda face,uv:True),2,spec['hair_head_above'],True)
                elif spec.get('hair_uv_regions'):
                    def is_hair(face, layer):
                        uv = sum((loop[layer].uv for loop in face.loops),Vector((0,0)))/len(face.loops)
                        return any(a<=uv.x<b and c<=uv.y<=d for a,b,c,d in spec['hair_uv_regions'])
                    face = select_faces(original,'face_'+name,lambda face,uv:not is_hair(face,uv))
                    hair = select_faces(original,'hair_'+name,is_hair)
                else:
                    face = select_faces(original,'face_'+name,lambda face,uv:True)
                    hair = select_faces(original,'hair_'+name,lambda face,uv:False)
                if name in spec.get('scalp_source_nodes',[]):
                    upper_scalp=clip(select_faces(face,'upper_scalp_'+name,lambda polygon,layer:True),2,canonical_face_top,True)
                    if upper_scalp.data.polygons:
                        scalp_parts.append(upper_scalp)
                    clip(face,2,canonical_face_top,False)
                    # 根据标准脸和头皮的真实表面转移分区，耳朵与脸不会被整球代替。
                    def fixed_face(polygon, layer):
                        center=polygon.calc_center_median()
                        return center.z<=canonical_face_top and head_surfaces[0].find_nearest(center)[3]<=head_surfaces[1].find_nearest(center)[3]
                    head_parts.append(select_faces(face,'fixed_'+name,fixed_face))
                    scalp_parts.append(select_faces(face,'scalp_'+name,lambda polygon,layer:not fixed_face(polygon,layer)))
                else:
                    head_parts.append(face)
                hair_parts.append(hair)
            head = join(head_parts,'body_head')
            if scalp_parts:
                # 原头壳两部分共同保持完整形状；空发型不会让额外支撑球遮住眼窝。
                support=canonical_parts['body_scalp']
                keep.remove(support)
                bpy.data.objects.remove(support,do_unlink=True)
                keep.append(join(scalp_parts,'body_scalp'))
            hair = join(hair_parts,'hair_provider') if any(len(obj.data.polygons) for obj in hair_parts) else None
            upper_parts, lower_parts, shoes_parts, hands = [],[],[],[]
            body_names = spec.get('body_nodes',[prefix+'_Body'])
            for name in body_names:
                upper = select_faces(parts[name],'upper_torso',lambda face,uv:True)
                shape_seam(upper,seams['waist'],.30,.24)
                upper_parts.append(clip(upper,2,seams['waist'],True))
                lower = select_faces(parts[name],'lower_hips',lambda face,uv:True)
                shape_seam(lower,seams['waist'],.30,.24)
                lower_parts.append(clip(lower,2,seams['waist'],False))
            for side,sign in [('Left',1),('Right',-1)]:
                for name in spec.get(('left' if sign>0 else 'right')+'_arm_nodes',[prefix+'_Arm'+side]):
                    arm = select_faces(parts[name],'upper_arm_'+side,lambda face,uv:True)
                    upper_parts.append(clip(arm,0,sign*seams['wrist'],sign<0))
                    hand = select_faces(parts[name],'hand_'+side,lambda face,uv:True)
                    hands.append(clip(hand,0,sign*seams['wrist'],sign>0))
                for name in spec.get(('left' if sign>0 else 'right')+'_leg_nodes',[prefix+'_Leg'+side]):
                    leg = select_faces(parts[name],'lower_leg_'+side,lambda face,uv:True)
                    shape_seam(leg,seams['ankle'],.10,.105,sign*.17)
                    lower_parts.append(clip(leg,2,seams['ankle'],True))
                    shoe = select_faces(parts[name],'shoe_'+side,lambda face,uv:True)
                    shape_seam(shoe,seams['ankle'],.10,.105,sign*.17)
                    shoes_parts.append(clip(shoe,2,seams['ankle'],False))
            upper_parts.extend(parts[name] for name in spec.get('upper_nodes',[]))
            fallback=spec.get('default_wearables',{})
            prepared = {'hair':hair,'upper':join(upper_parts,'upper_provider'),'lower':canonical_parts['lower_rogue'] if 'lower' in fallback else join(lower_parts,'lower_provider'),'shoes':canonical_parts['shoes_rogue'] if 'shoes' in fallback else join(shoes_parts,'shoes_provider')}
            hand = join(hands,'body_hands')
            deliver = keep+[head,hand]+[obj for obj in prepared.values() if obj is not None]
            for obj in list(bpy.data.objects):
                if obj.type == 'MESH' and obj not in deliver:
                    bpy.data.objects.remove(obj,do_unlink=True)
            if source_rig is not None and source_rig != rig:
                bpy.data.objects.remove(source_rig,do_unlink=True)
            bpy.context.view_layer.update()
            for obj in deliver:
                if not obj.data.polygons:
                    raise ValueError(f'empty mesh {obj.name}')
                if any(sum(group.weight for group in vertex.groups)<.999 for vertex in obj.data.vertices):
                    raise ValueError(f'incomplete normalized weights {obj.name}')
            binding_error = max(abs(a-b) for bone in rig.data.bones for row_a,row_b in zip(bone.matrix_local,canonical_matrices[bone.name]) for a,b in zip(row_a,row_b))
            temporary = ROOT/'.local/3d-sources/provider-character-work'/f"{spec['key']}.glb"
            temporary.parent.mkdir(parents=True,exist_ok=True)
            bpy.ops.object.select_all(action='DESELECT')
            for obj in deliver+[rig]:
                obj.select_set(True)
            bpy.context.view_layer.objects.active=rig
            bpy.ops.export_scene.gltf(filepath=str(temporary),export_format='GLB',use_selection=True,export_animations=False,export_skins=True,export_def_bones=False)
            model_key = asset_version(spec['key'],temporary.read_bytes(),spec)
            (BUILTIN/(model_key+'.glb')).write_bytes(temporary.read_bytes())
            url = '/api/v1/assets/'+model_key
            definition=copy.deepcopy(base)
            definition.update(character_key=spec['key'],body_key=config['body_key'],name=spec['name'],provider=spec['provider'],pack_key=spec['pack_key'],rig_key=config['rig_key'],model_asset_key=model_key,model_url=url)
            model_asset={'key':model_key,'name':spec['name'],'kind':'model','url':url,'format':'glb','source_url':pack['source_url'],'license':pack['license'],'provider':spec['provider'],'pack_key':spec['pack_key']}
            assets[model_key]=model_asset
            wearables=[]
            for slot,obj in prepared.items():
                if slot in fallback:
                    definition['defaults'][slot]=fallback[slot]
                    continue
                wearable_key = spec['key']+'-'+slot
                thumbnail_key=model_key+'-'+slot
                render([obj] if obj is not None else [head],BUILTIN/(thumbnail_key+'.png'))
                thumbnail_asset={**model_asset,'key':thumbnail_key,'name':spec['name'],'kind':'wearable','url':'/api/v1/assets/'+thumbnail_key,'format':'png'}
                assets[thumbnail_key]=thumbnail_asset
                covers={'hair':['scalp'],'upper':['torso','arms'],'lower':['legs'],'shoes':['feet']}[slot]
                if slot=='hair':
                    covers=spec.get('hair_covers',covers)
                wearables.append(dict(wearable_key=wearable_key,name=spec['name'],slot=slot,body_key=config['body_key'],character_key=spec['key'],provider=spec['provider'],pack_key=spec['pack_key'],rig_key=config['rig_key'],model_asset_key=model_key,model_url=url,thumbnail_asset_key=thumbnail_key,thumbnail_url=thumbnail_asset['url'],nodes=[obj.name] if obj is not None else [],covers=covers if obj is not None else [],**({'empty':True} if obj is None else {})))
                definition['defaults'][slot]=wearable_key
            thumbnail_key=model_key+'-thumbnail'
            # 支撑身体只展示未被默认衣服覆盖的固定头与手，避免服装内部身体穿出。
            default_covers=set(region for wearable in wearables for region in wearable['covers'])
            known_wearables=json.loads((ROOT/'internal/character/character-catalog.json').read_text())['wearables']
            for existing in known_wearables:
                if existing['wearable_key'] in fallback.values():
                    default_covers.update(existing['covers'])
            visible_support=[obj for obj in keep if obj.name.removeprefix('body_') not in default_covers]
            render([head,hand]+visible_support+[obj for obj in prepared.values() if obj is not None],BUILTIN/(thumbnail_key+'.png'))
            definition.update(thumbnail_asset_key=thumbnail_key,thumbnail_url='/api/v1/assets/'+thumbnail_key)
            assets[thumbnail_key]={**model_asset,'key':thumbnail_key,'name':spec['name'],'kind':'character','url':definition['thumbnail_url'],'format':'png'}
            entry={'status':'imported','provider':spec['provider'],'pack_key':spec['pack_key'],'source':str(source.relative_to(ROOT)),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'source_archive_sha256':pack['archive_sha256'],'definition':definition,'wearables':wearables,'binding_error':binding_error,'face_hair_disjoint':face_hair_disjoint,'bones':sorted(canonical_names),'mesh_counts':{obj.name:len(obj.data.polygons) for obj in deliver},'seams':seams,'coordinate_system':'+Y up in GLB, meters before shared scale','normalization':normalization_evidence or {'method':'Per-vertex weighted source bind to canonical rest matrices, shared seam geometry and target inverse bind matrices.'},'augmentation':spec.get('normalization',{}).get('augmentation',[]),'support_material':spec.get('support_material')}
            if scalp_parts:
                entry['scalp_partition']={'source_bounds':source_head_bounds,'standard_head_bounds':canonical_head_bounds,'scalp_node':'body_scalp','source_nodes':spec['scalp_source_nodes'],'method':'Source cranial faces partitioned by nearest canonical face/scalp surfaces; eyes and jaw remain fixed; complete source head fitted within standard envelope.'}
            entries[spec['key']]=entry
            print('CHARACTER_IMPORTED',spec['key'],model_key,flush=True)
        except Exception as error:
            import traceback
            traceback.print_exc()
            failures.append({'character_key':spec['key'],'status':'failed','error':str(error)})
        result={**previous,'body_key':config['body_key'],'characters':list(entries.values()),'assets':list(assets.values()),'failures':failures}
        if 'pending' in result:
            result['pending']=[item for item in result['pending'] if item['character_key'] not in entries]
        MANIFEST.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    if options.evidence:
        evidence_directory=options.evidence_output
        evidence_directory.mkdir(parents=True,exist_ok=True)
        evidence_entries={key:entry for key,entry in entries.items() if not options.only or key in options.only}
        for key,entry in evidence_entries.items():
            bpy.ops.wm.read_factory_settings(use_empty=True)
            source=ROOT/entry['source']
            if source.suffix.lower()=='.fbx':
                bpy.ops.import_scene.fbx(filepath=str(source))
            else:
                bpy.ops.import_scene.gltf(filepath=str(source))
            for rig_object in [obj for obj in bpy.data.objects if obj.type=='ARMATURE']:
                rig_object.animation_data_clear()
                rig_object.data.pose_position='REST'
            bpy.context.view_layer.update()
            spec=source_specs[key]
            requested=set(spec['head_nodes']+spec.get('hair_nodes',[])+spec.get('upper_nodes',[]))
            for field,default in [('body_nodes','_Body'),('left_arm_nodes','_ArmLeft'),('right_arm_nodes','_ArmRight'),('left_leg_nodes','_LegLeft'),('right_leg_nodes','_LegRight')]:
                requested.update(spec.get(field,[spec.get('prefix','')+default]))
            raw=[obj for obj in bpy.data.objects if obj.type=='MESH' and obj.name in requested]
            render(raw,evidence_directory/(key+'-source.png'))
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=str(BUILTIN/(entry['definition']['model_asset_key']+'.glb')))
            target=next(obj for obj in bpy.data.objects if obj.type=='ARMATURE')
            target.animation_data_clear()
            target.data.pose_position='POSE'
            # 共用 Rogue 发型覆盖头皮，与正式换装页面采用同一显隐规则。
            fixed=[obj for obj in bpy.data.objects if obj.type=='MESH' and obj.name in entry['definition']['fixed_nodes']]
            before=set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(ROOT/config['canonical_model']))
            added=set(bpy.data.objects)-before
            source_rig=next(obj for obj in added if obj.type=='ARMATURE')
            source_rig.animation_data.action=None
            for track in source_rig.animation_data.nla_tracks:
                track.mute=track.name!='Idle'
            bpy.context.scene.frame_set(1)
            bpy.context.view_layer.update()
            for bone in target.pose.bones:
                bone.matrix_basis=source_rig.pose.bones[bone.name].matrix_basis.copy()
            outfit=[]
            for obj in added:
                if obj.type!='MESH' or obj.name.split('.')[0] not in ['hair_rogue','upper_rogue','lower_rogue','shoes_rogue']:
                    continue
                obj.parent=target
                obj.parent_type='OBJECT'
                obj.matrix_parent_inverse=Matrix.Identity(4)
                obj.matrix_basis=Matrix.Identity(4)
                for modifier in obj.modifiers:
                    if modifier.type=='ARMATURE':
                        modifier.object=target
                outfit.append(obj)
            bpy.context.view_layer.update()
            render(fixed+outfit,evidence_directory/(key+'-shared-outfit.png'))
        print('CHARACTER_EVIDENCE',len(evidence_entries),str(evidence_directory),flush=True)
        return
    catalog=json.loads((ROOT/'internal/character/character-catalog.json').read_text())
    original_characters=[definition for definition in catalog['characters'] if definition['character_key'] not in entries]
    original_wearables=[wearable for wearable in catalog['wearables'] if wearable['character_key'] not in entries]
    catalog['characters']=original_characters+[entry['definition'] for entry in entries.values()]
    catalog['wearables']=original_wearables+[wearable for entry in entries.values() for wearable in entry['wearables']]
    (ROOT/'internal/character/character-catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
    print('CHARACTER_SUMMARY',json.dumps({'imported':len(entries),'failed':len(failures)}),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only',action='append',default=[])
    parser.add_argument('--force',action='store_true')
    parser.add_argument('--evidence',action='store_true')
    parser.add_argument('--evidence-output',type=Path,default=ROOT/'.local/3d-sources/provider-character-work/evidence')
    arguments=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    import_characters(parser.parse_args(arguments))
