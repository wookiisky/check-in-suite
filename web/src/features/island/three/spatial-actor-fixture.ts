import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialLayout } from './spatial-navigation';
import type { SpatialActorEnvironment, SpatialBallTiming } from './spatial-actor';
import type { IslandAccess } from '../island-activity-access';

// 使用与正式目录不同的时间和位置，证明轨迹读取传入的绑定。
export const testBallTiming:SpatialBallTiming={period_seconds:2,contact_seconds:0.75,contact_position:[-0.2,0.45,0.55]};

const readPresentation={action:'read',attachment:{model_url:'/book',bone:'handslotl',matrix:Array<number>(16).fill(0)}};

// 测试保留正式地形、门洞和卫生间墙，只替换活动陈设。
export function navigationFixture(): SpatialLayout {
  return {version:1,scene_key:configuration.scene.scene_key,environment_key:configuration.default_environment,inventory:[],
    placements:structuredClone(configuration.default_placements) as SpatialLayout['placements'],
    catalog:structuredClone(configuration.catalog) as SpatialLayout['catalog'],
    scene:{...structuredClone(configuration.scene),activity_presentations:{read:readPresentation,run:{action:'exercise'},ball:{action:'play',ball:testBallTiming}}} as SpatialLayout['scene']};
}

// 资格和布局使用真实协议字段，只缩小活动目标以检查执行状态。
export function spatialActorFixture() {
  const layout=navigationFixture();
  layout.placements=layout.placements.filter(item=>layout.catalog.find(definition=>definition.item_key===item.item_key)?.assembly==='house');
  const desk:SpatialLayout['catalog'][number]={...layout.catalog[0]!,item_key:'desk',footprint:{width_cm:100,depth_cm:100},walk_obstacle:{width_cm:100,depth_cm:100},interaction:{activity:'read',x_cm:0,z_cm:100,rotation:2,pose:{x_cm:0,y_cm:10,z_cm:30,rotation:2}}};
  delete desk.assembly;layout.catalog.push(desk);
  layout.placements.push({instance_id:'desk1',item_key:'desk',space:'indoor',x_cm:0,z_cm:-120,rotation:0});
  let time=0;
  const access:IslandAccess={today:'1970-01-01',expires_at:new Date(1000).toISOString(),activity_access:[{activity:'read',available:true,tasks:[{id:'task1',name:'reading',enabled:true}]}]};
  const environment:SpatialActorEnvironment={layout,access,now:()=>time,editing:false,paused:false};
  return {environment,setTime:(next:number)=>{time=next;}};
}

