import { describe, expect, it } from 'vitest';
import { createSpatialNavigation, spatialLocalToWorld, type SpatialLayout } from './spatial-navigation';
import { navigationFixture } from './spatial-actor-fixture';

describe('三维厘米导航', () => {
  it('按完整身体半径拒绝岸边、水和场景外', () => {
    const nav = createSpatialNavigation(navigationFixture());
    expect(nav.walkable({x_cm:800,z_cm:965})).toBe(true);
    expect(nav.walkable({x_cm:800,z_cm:966})).toBe(false);
    expect(nav.walkable({x_cm:800,z_cm:1100})).toBe(false);
    expect(nav.walkable({x_cm:1490,z_cm:0})).toBe(false);
  });
  it('身体经90cm门洞进入，移动房屋后仍保留门中心通路', () => {
    const layout = navigationFixture();
    layout.placements[0]!.x_cm = 7; layout.placements[0]!.z_cm = 13;
    const nav = createSpatialNavigation(layout);
    const path = nav.path({x_cm:7,z_cm:500}, {x_cm:7,z_cm:13});
    expect(path).not.toBeNull();
    expect(nav.walkable({x_cm:7,z_cm:308})).toBe(true);
    expect(path!.every(point=>nav.walkable(point))).toBe(true);
    expect(nav.space({x_cm:7,z_cm:13})).toBe('indoor');
    expect(nav.walkable({x_cm:107,z_cm:308})).toBe(false);
  });
  it('仅walk_obstacle阻挡，并绕开家具且不穿过转角', () => {
    const layout = navigationFixture();
    const definition:SpatialLayout['catalog'][number] = { ...layout.catalog[0]!, item_key:'crate', footprint:{width_cm:400,depth_cm:400}, walk_obstacle:{width_cm:80,depth_cm:80} };
    delete definition.assembly;
    layout.catalog.push(definition);
    layout.placements.push({instance_id:'crate1',item_key:'crate',space:'outdoor',x_cm:600,z_cm:0,rotation:0});
    const nav = createSpatialNavigation(layout);
    expect(nav.walkable({x_cm:720,z_cm:0})).toBe(true);
    const path = nav.path({x_cm:480,z_cm:0},{x_cm:720,z_cm:0});
    expect(path).not.toBeNull(); expect(path!.some(point=>Math.abs(point.z_cm)>=75)).toBe(true);
    expect(nav.path({x_cm:480,z_cm:0},{x_cm:600,z_cm:0})).toBeNull();
  });
  it('室内物件随房屋世界变换，隔墙不因整体房屋占地而消失', () => {
    const layout = navigationFixture(); layout.placements[0]!.x_cm=200;
    expect(spatialLocalToWorld({x_cm:10,z_cm:20},layout.placements[0]!)).toEqual({x_cm:210,z_cm:20});
    layout.scene.house.walls!.push({min_x_cm:-100,max_x_cm:-90,min_z_cm:-290,max_z_cm:290});
    const nav=createSpatialNavigation(layout);
    expect(nav.path({x_cm:50,z_cm:0},{x_cm:200,z_cm:0})).toBeNull();
    expect(nav.walkable({x_cm:105,z_cm:0})).toBe(false);
  });
  it('按正式卫生间门洞转弯，不穿过共用隔墙',()=>{
    const nav=createSpatialNavigation(navigationFixture());
    const path=nav.path({x_cm:0,z_cm:0},{x_cm:200,z_cm:-200});
    expect(path).not.toBeNull();
    expect(nav.walkable({x_cm:105,z_cm:-175})).toBe(true);
    expect(nav.walkable({x_cm:160,z_cm:-95})).toBe(false);
    for(let index=1;index<path!.length;index++) {
      const a=path![index-1]!,b=path![index]!;
      const steps=Math.ceil(Math.hypot(a.x_cm-b.x_cm,a.z_cm-b.z_cm)/2);
      for(let step=0;step<=steps;step++)expect(nav.walkable({x_cm:a.x_cm+(b.x_cm-a.x_cm)*step/(steps||1),z_cm:a.z_cm+(b.z_cm-a.z_cm)*step/(steps||1)})).toBe(true);
    }
  });
  it('正式默认室内书桌的approach可从门外经门洞到达',()=>{
    const layout=navigationFixture(),nav=createSpatialNavigation(layout);
    const desk=layout.placements.find(item=>item.instance_id==='base:reading3d')!;
    const interaction=layout.catalog.find(item=>item.item_key===desk.item_key)!.interaction!;
    const approach=spatialLocalToWorld(spatialLocalToWorld(interaction,desk),nav.house);
    const path=nav.path(spatialLocalToWorld({x_cm:0,z_cm:470},nav.house),approach);
    expect(desk.space).toBe('indoor');expect(nav.walkable(approach)).toBe(true);
    expect(path).not.toBeNull();expect(path!.every(point=>nav.walkable(point))).toBe(true);
    expect(path!.at(-1)).toEqual(approach);
    expect(path!.some(point=>Math.abs(point.x_cm-nav.house.x_cm)<=10&&point.z_cm>=280&&point.z_cm<=320)).toBe(true);
    expect(nav.space(approach)).toBe('indoor');
  });
});
