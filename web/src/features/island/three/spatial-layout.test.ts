import { describe, expect, it } from 'vitest';
import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialIslandState } from './spatial-ui-types';
import { layoutIssue, firstAvailablePlacement } from './spatial-layout';

const state={version:1,scene_key:configuration.scene.scene_key,environment_key:'day',scene:configuration.scene,catalog:configuration.catalog,placements:configuration.default_placements,inventory:configuration.default_placements.map((p)=>({instance_id:p.instance_id,item_key:p.item_key}))} as SpatialIslandState;
describe('三维布局完整占地',()=>{
  it('保留一个主屋并拒绝缺屋、越界及未拥有实例',()=>{
    expect(layoutIssue(state,state.placements)).toBeNull();
    expect(layoutIssue(state,[])).toBe('house');
    expect(layoutIssue(state,state.placements.map(p=>p.item_key==='camp-house-v1'?{...p,x_cm:1450}:p))).toBe('terrain');
    expect(layoutIssue(state,[...state.placements,{...state.placements[0]!,instance_id:'foreign'}])).toBe('ownership');
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
