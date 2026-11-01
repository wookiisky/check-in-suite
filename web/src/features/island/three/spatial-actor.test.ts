import { describe, expect, it } from 'vitest';
import { SpatialActorController, spatialBallPosition, spatialWalkSurfaceHeight } from './spatial-actor';
import type { SpatialActorEnvironment } from './spatial-actor';
import { navigationFixture, spatialActorFixture } from './spatial-actor-fixture';
import type { SpatialLayout } from './spatial-navigation';
import { spatialLocalToWorld } from './spatial-navigation';
import houses from '../../../../../internal/island/spatial-houses.json';

describe('三维角色统一活动执行器',()=>{
  it.each([
    ['tiny-treats-courtyard-v1',200,350,40],
    ['tiny-treats-courtyard-v1',-200,350,40],
    ['tiny-treats-cottage-v1',120,250,20.665],
  ] as const)('沿实际%s侧平台高度行走，移动房屋后保持局部高度', (key,x,z,height)=>{
    const {environment}=spatialActorFixture();
    const layout=environment.layout;
    layout.catalog.push(...houses.catalog as SpatialLayout['catalog']);
    layout.scene.house=houses.houses.find(house=>house.house_key===key)!;
    layout.placements=[{instance_id:'house',item_key:key,space:'outdoor',x_cm:7,z_cm:13,rotation:0}];
    const actor=new SpatialActorController(environment);
    const destination={x_cm:7+Number(x),z_cm:13+Number(z)};
    expect(actor.navigation.walkable(destination)).toBe(true);
    expect(actor.request({sequence:1,activity:'walk',destination},environment)).toBeNull();
    actor.advance(30,environment);
    expect(actor.position.x_cm).toBe(destination.x_cm);
    expect(actor.position.z_cm).toBe(destination.z_cm);
    expect(actor.position.y_cm).toBeCloseTo(Number(height),2);
  });
  it('实际楼板插值取最高面并包含共边，外部及退化面不产生高度',()=>{
    const vertices=[{x_cm:0,y_cm:10,z_cm:0},{x_cm:100,y_cm:20,z_cm:0},{x_cm:0,y_cm:30,z_cm:100}];
    const upper=vertices.map(vertex=>({...vertex,y_cm:vertex.y_cm+20}));
    const surface={vertices:[...vertices,...upper],triangles:[[0,1,2],[3,4,5],[0,0,0]]};
    expect(spatialWalkSurfaceHeight({x_cm:25,z_cm:25},surface)).toBeCloseTo(37.5);
    expect(spatialWalkSurfaceHeight({x_cm:50,z_cm:50},surface)).toBeCloseTo(45);
    expect(spatialWalkSurfaceHeight({x_cm:0,z_cm:0},surface)).toBe(30);
    expect(spatialWalkSurfaceHeight({x_cm:75,z_cm:75},surface)).toBeNull();
    expect(spatialWalkSurfaceHeight({x_cm:0,z_cm:0},{vertices:[],triangles:[]})).toBeNull();
  });
  it('高地板房屋沿实际门外通路连续抬高人物，离开后回到地面',()=>{
    const {environment}=spatialActorFixture();
    environment.layout.placements=environment.layout.placements.filter(item=>environment.layout.catalog.find(definition=>definition.item_key===item.item_key)?.assembly==='house');
    environment.layout.scene.house!.floor_height_cm=40;
    const actor=new SpatialActorController(environment);
    expect(actor.position).toEqual({x_cm:0,z_cm:470,y_cm:0});
    expect(actor.request({sequence:1,activity:'walk',destination:{x_cm:0,z_cm:0}},environment)).toBeNull();
    actor.advance(1.1,environment);
    expect(actor.position.z_cm).toBeCloseTo(360);
    expect(actor.position.y_cm).toBeCloseTo(20);
    actor.advance(0.7,environment);
    expect(actor.position.y_cm).toBe(40);
    actor.advance(10,environment);
    expect(actor.request({sequence:2,activity:'walk',destination:{x_cm:0,z_cm:470}},environment)).toBeNull();
    actor.advance(10,environment);
    expect(actor.position.y_cm).toBe(0);
  });
  it('实测入口高度保留平台平面，只有台阶所在区间改变高度',()=>{
    const {environment}=spatialActorFixture();
    environment.layout.placements=environment.layout.placements.filter(item=>environment.layout.catalog.find(definition=>definition.item_key===item.item_key)?.assembly==='house');
    Object.assign(environment.layout.scene.house!,{floor_height_cm:40,entry_height_profile:[{z_cm:300,y_cm:40},{z_cm:360,y_cm:40},{z_cm:420,y_cm:0}]});
    const actor=new SpatialActorController(environment);
    actor.request({sequence:1,activity:'walk',destination:{x_cm:0,z_cm:0}},environment);
    actor.advance(0.8,environment);expect(actor.position.z_cm).toBeCloseTo(390);expect(actor.position.y_cm).toBeCloseTo(20);
    actor.advance(0.3,environment);expect(actor.position.z_cm).toBeCloseTo(360);expect(actor.position.y_cm).toBe(40);
    actor.advance(0.3,environment);expect(actor.position.z_cm).toBeCloseTo(330);expect(actor.position.y_cm).toBe(40);
  });
  it('无房场景出生在配置落点，能散步休息并拒绝室内请求',()=>{
    const {environment}=spatialActorFixture();
    environment.layout.placements=[];
    Object.assign(environment.layout.scene,{house:null,spawn:{x_cm:600,z_cm:300},fixed_objects:[]});
    const actor=new SpatialActorController(environment);
    expect(actor.position).toEqual({x_cm:600,z_cm:300,y_cm:0});
    expect(actor.request({sequence:1,activity:'rest'},environment)).toBeNull();
    expect(actor.request({sequence:2,activity:'walk',space:'indoor'},environment)).toBe('unreachable');
    expect(actor.request({sequence:3,activity:'walk',destination:{x_cm:800,z_cm:400}},environment)).toBeNull();
    actor.advance(10,environment);
    expect(actor.position).toEqual({x_cm:800,z_cm:400,y_cm:0});
    expect(actor.status.space).toBe('outdoor');
  });
  it('切换场景停止原有活动并采用目标场景落点',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment);
    actor.request({sequence:1,activity:'read'},environment);actor.advance(30,environment);
    const target=structuredClone(environment.layout);target.scene_key='forest-courtyard-v1';
    target.scene.scene_key=target.scene_key;target.placements=[];
    Object.assign(target.scene,{house:null,spawn:{x_cm:600,z_cm:300},fixed_objects:[]});
    actor.advance(0,{...environment,layout:target});
    expect(actor.status.phase).toBe('idle');expect(actor.status.space).toBe('outdoor');
    expect(actor.attachments).toHaveLength(0);
    expect(actor.position).toEqual({x_cm:600,z_cm:300,y_cm:0});
  });
  it('走到approach后才进入pose，结束回可行走位置',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment,()=>0.2);
    expect(actor.request({sequence:1,activity:'read'},environment)).toBeNull();
    expect(actor.status.phase).toBe('walking'); expect(actor.action).toBe('walk');
    actor.advance(30,environment);
    expect(actor.status.phase).toBe('performing');expect(actor.action).toBe('read');
    expect(actor.position).toEqual({x_cm:0,y_cm:20,z_cm:-90});
    expect(actor.attachments[0]?.bone).toBe('handslotl');
    actor.advance(13,environment);
    expect(actor.status.phase).toBe('idle');expect(actor.position.z_cm).toBe(-20);
    expect(actor.navigation.walkable(actor.position)).toBe(true);
  });
  it('暂停时也立即撤销过期资格且不推进时间',()=>{
    const {environment,setTime}=spatialActorFixture(),actor=new SpatialActorController(environment);
    actor.request({sequence:1,activity:'read'},environment);actor.advance(30,environment);
    const elapsed=actor.elapsed;
    actor.advance(3,{...environment,paused:true});expect(actor.elapsed).toBe(elapsed);
    setTime(1000);actor.advance(0,{...environment,paused:true});
    expect(actor.status.phase).toBe('idle');expect(actor.action).toBe('idle');expect(actor.attachments).toHaveLength(0);
    expect(actor.request({sequence:2,activity:'read'},environment)).toBe('locked');
  });
  it('收起或移动目标时停止表演，编辑期间不重建且结束后按最终布局恢复',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment);
    actor.request({sequence:1,activity:'read'},environment);actor.advance(30,environment);
    const changed=structuredClone(environment.layout);changed.placements.find(item=>item.instance_id==='desk1')!.x_cm=100;
    actor.advance(0,{...environment,layout:changed,editing:true});
    expect(actor.status.phase).toBe('performing');
    actor.advance(0,{...environment,layout:changed,editing:false});
    expect(actor.status.phase).toBe('idle');expect(actor.navigation.walkable(actor.position)).toBe(true);
    actor.request({sequence:2,activity:'read'}, {...environment,layout:changed});
    const stored=structuredClone(changed);stored.placements=stored.placements.filter(item=>item.instance_id!=='desk1');
    actor.advance(0,{...environment,layout:stored,paused:true});expect(actor.status.phase).toBe('idle');
    expect(actor.request({sequence:3,activity:'read'}, {...environment,layout:stored})).toBe('missing_target');
  });
  it('不可达目标不会启动活动；散步和休息无资格也能执行',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment);
    const blocked=structuredClone(environment.layout);blocked.scene.house!.walls.push({min_x_cm:-45,max_x_cm:45,min_z_cm:290,max_z_cm:300});
    const next={...environment,layout:blocked};
    expect(actor.request({sequence:1,activity:'read'},next)).toBe('unreachable');expect(actor.status.phase).toBe('idle');
    expect(actor.request({sequence:2,activity:'rest'},{...next,access:null})).toBeNull();expect(actor.status.activity).toBe('rest');
    expect(actor.request({sequence:3,activity:'walk',destination:{x_cm:500,z_cm:500}},{...next,access:null})).toBeNull();
  });
  it('球轨迹在艺术动作触球时刻经过脚尖，并闭合循环',()=>{
    spatialBallPosition(0.625).forEach((value,index)=>expect(value).toBeCloseTo([-0.1407,0.4362,0.5835][index]!));
    expect(spatialBallPosition(0)).toEqual(spatialBallPosition(1.5));
    expect(spatialBallPosition(0.75)[2]).toBeGreaterThan(spatialBallPosition(0.625)[2]);
  });
  it('面向水域的球目标不启动越岸轨迹',()=>{
    const {environment}=spatialActorFixture(),layout=environment.layout;
    const definition:SpatialLayout['catalog'][number]={...layout.catalog[0]!,item_key:'ball',footprint:{width_cm:36,depth_cm:36},interaction:{activity:'ball',x_cm:0,z_cm:60,rotation:2}};
    delete definition.assembly;delete definition.walk_obstacle;
    layout.catalog.push(definition);layout.placements.push({instance_id:'ball1',item_key:'ball',space:'outdoor',x_cm:600,z_cm:980,rotation:2});
    const next:SpatialActorEnvironment={...environment,access:{...environment.access!,activity_access:[{activity:'ball',available:true,tasks:[]}]}};
    const actor=new SpatialActorController(next);
    expect(actor.request({sequence:1,activity:'ball'},next)).toBe('unreachable');
  });
  it('自主活动使用同一个规划执行流程，相同布局重读不打断表演',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment,()=>0.99);
    actor.advance(5,environment);expect(actor.status.activity).toBe('read');expect(actor.status.phase).toBe('walking');
    actor.advance(30,environment);expect(actor.status.phase).toBe('performing');
    actor.advance(0,{...environment,layout:structuredClone(environment.layout)});
    expect(actor.status.phase).toBe('performing');
    actor.advance(0,{...environment,access:null,paused:true});expect(actor.status.phase).toBe('idle');
  });
  it('散步命令完成真实过门路线后更新屋内状态',()=>{
    const {environment}=spatialActorFixture(),actor=new SpatialActorController(environment);
    actor.request({sequence:1,activity:'walk',destination:{x_cm:0,z_cm:0},space:'indoor'},environment);
    actor.advance(30,environment);expect(actor.status.space).toBe('indoor');expect(actor.position.y_cm).toBe(10);
    actor.request({sequence:2,activity:'walk',destination:{x_cm:500,z_cm:500},space:'outdoor'},environment);
    actor.advance(30,environment);expect(actor.status.space).toBe('outdoor');expect(actor.position.y_cm).toBe(0);
  });
  it('正式免费书桌与运动区使用业务身份选择目标和各自语义动作',()=>{
    const {environment}=spatialActorFixture();
    const next:SpatialActorEnvironment={...environment,layout:navigationFixture(),access:{...environment.access!,activity_access:[{activity:'read',available:true,tasks:[]},{activity:'run',available:true,tasks:[]}]}};
    const actor=new SpatialActorController(next);
    expect(actor.request({sequence:1,activity:'read'},next)).toBeNull();actor.advance(30,next);
    expect(actor.status.targetInstanceId).toBe('base:reading3d');expect(actor.action).toBe('read');expect(actor.attachments).toHaveLength(1);
    const desk=next.layout.placements.find(item=>item.instance_id==='base:reading3d')!;
    const pose=next.layout.catalog.find(item=>item.item_key===desk.item_key)!.interaction!.pose!;
    const expectedRoot=spatialLocalToWorld(spatialLocalToWorld(pose,desk),actor.navigation.house!);
    expect(actor.status.space).toBe('indoor');expect(actor.position).toEqual({...expectedRoot,y_cm:next.layout.scene.house!.floor_height_cm+pose.y_cm});
    expect(actor.request({sequence:2,activity:'run'},next)).toBeNull();actor.advance(30,next);
    expect(actor.status.targetInstanceId).toBe('base:sport3d');expect(actor.action).toBe('exercise');expect(actor.attachments).toHaveLength(0);
  });
});
