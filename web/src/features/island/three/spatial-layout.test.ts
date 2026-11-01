import { describe, expect, it } from 'vitest';
import configuration from '../../../../../internal/island/spatial-scene.json';
import houseConfiguration from '../../../../../internal/island/spatial-houses.json';
import type { SpatialIslandState } from './spatial-ui-types';
import { layoutIssue, firstAvailablePlacement, houseForPlacements } from './spatial-layout';

const state={version:1,scene_key:configuration.scene.scene_key,environment_key:'day',scene:configuration.scene,catalog:configuration.catalog,placements:configuration.default_placements,inventory:configuration.default_placements.map((p)=>({instance_id:p.instance_id,item_key:p.item_key}))} as SpatialIslandState;
describe('三维布局完整占地',()=>{
  it('实际Tiny Treats房屋的分数厘米门外通路可验证并从库存摆放',()=>{
    const house=houseConfiguration.houses.find(item=>item.house_key==='tiny-treats-cottage-v1')!;
    const definition=houseConfiguration.catalog.find(item=>item.house_key===house.house_key)! as SpatialIslandState['catalog'][number];
    const item={instance_id:'cottage-owned',item_key:definition.item_key};
    const owned={...state,scene:{...state.scene,house:null},houses:{[house.house_key]:house},catalog:[...state.catalog,definition],inventory:[...state.inventory,item],placements:[]};
    const candidate=firstAvailablePlacement(owned,[],item,'outdoor');
    expect(candidate).not.toBeNull();
    expect(layoutIssue(owned,[candidate!])).toBeNull();
    expect(layoutIssue(owned,[{...candidate!,x_cm:candidate!.x_cm+0.5}])).toBe('boundary');
  });
  it('允许无房场景，并拒绝越界及未拥有实例',()=>{
    expect(layoutIssue(state,state.placements)).toBeNull();
    expect(layoutIssue(state,[])).toBeNull();
    expect(layoutIssue(state,state.placements.map(p=>p.item_key==='camp-house-v1'?{...p,x_cm:1450}:p))).toBe('terrain');
    expect(layoutIssue(state,[...state.placements,{...state.placements[0]!,instance_id:'foreign'}])).toBe('ownership');
  });
  it('无房时不能摆室内家具，房型按草稿主屋解析而不沿用保存房屋',()=>{
    const indoor={instance_id:'indoor-chair',item_key:'camp-dining-chair-v1',space:'indoor' as const,x_cm:180,z_cm:0,rotation:0};
    const oldHouse=state.scene.house!;
    const newHouse={...oldHouse,interior:{min_x_cm:-100,max_x_cm:100,min_z_cm:-100,max_z_cm:100}};
    const houseDefinition={...state.catalog[0]!,item_key:'small-house',house_key:'small-v1'};
    const small={...state.placements[0]!,instance_id:'small',item_key:'small-house'};
    const owned={...state,houses:{'small-v1':newHouse},catalog:[...state.catalog,houseDefinition],inventory:[...state.inventory,{instance_id:'small',item_key:'small-house'},{instance_id:indoor.instance_id,item_key:indoor.item_key}]};
    expect(houseForPlacements(owned,[small])).toEqual(newHouse);
    expect(layoutIssue(owned,[indoor])).toBe('house');
    expect(layoutIssue(owned,[small,indoor])).toBe('boundary');
    expect(layoutIssue(owned,[state.placements[0]!,small])).toBe('house');
  });
  it('不能从另一场景直接复制被占用实例',()=>{
    const elsewhere={...state,inventory:state.inventory.map(item=>({...item,placed_scene_key:'forest-courtyard-v1'}))};
    expect(layoutIssue(elsewhere,state.placements)).toBe('ownership');
    expect(firstAvailablePlacement(elsewhere,[],elsewhere.inventory[0]!,'outdoor')).toBeNull();
  });
  it('固定景物同时阻挡摆放，新增位置不把库存占用字段带入保存协议',()=>{
    const definition=state.catalog.find(item=>item.item_key==='camp-lamp-v1')!;
    const item={instance_id:'lamp-owned',item_key:definition.item_key,placed_scene_key:state.scene_key};
    const candidate={instance_id:item.instance_id,item_key:item.item_key,space:'outdoor' as const,x_cm:-900,z_cm:0,rotation:0};
    const owned={...state,inventory:[...state.inventory,item],scene:{...state.scene,fixed_objects:[{key:'fixed-tree',model_url:'/tree.glb',x_cm:-900,z_cm:0,rotation:0,scale:1,footprint:{width_cm:100,depth_cm:100},blocks_placement:true}]}};
    expect(layoutIssue(owned,[candidate])).toBe('overlap');
    expect(firstAvailablePlacement(owned,[],item,'outdoor')).not.toHaveProperty('placed_scene_key');
  });
  it('库存添加查找实际可用位置，家具不能跨墙或门口通路',()=>{
    const desk=state.catalog.find(d=>d.item_key==='camp-dining-chair-v1');
    if(!desk) return;
    const item={instance_id:'desk-extra',item_key:desk.item_key};
    const owned={...state,inventory:[...state.inventory,item]};
    const candidate=firstAvailablePlacement(owned,state.placements,item,'indoor');
    expect(candidate).not.toBeNull();
    expect(layoutIssue(owned,[...state.placements,candidate!])).toBeNull();
    expect(layoutIssue(owned,[...state.placements,{...candidate!,x_cm:295,z_cm:0}])).toBe('boundary');
    expect(layoutIssue(owned,[...state.placements,{...candidate!,x_cm:0,z_cm:260}])).not.toBeNull();
  });
});
