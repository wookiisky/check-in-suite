import { spatialFootprintCovered, spatialPlacementRect, spatialRectCovered, spatialRectsOverlap } from '../spatial-geometry';
import type { SpatialRect } from '../spatial-geometry';
import type { SpatialHouse, SpatialIslandState, SpatialOwnedItem, SpatialPlacement, SpatialSpace } from './spatial-ui-types';

export type LayoutIssue='ownership'|'house'|'terrain'|'boundary'|'wall'|'door'|'overlap'|'fixed';

// 草稿以所选主屋解析几何，无房时不沿用服务端已保存房屋的室内范围。
export function houseForPlacements(state:SpatialIslandState,placements:SpatialPlacement[]):SpatialHouse|null {
  const house=placements.find(placement=>state.catalog.find(item=>item.item_key===placement.item_key)?.assembly==='house');
  if(!house)return null;
  const definition=state.catalog.find(item=>item.item_key===house.item_key);
  if(definition?.house_key&&state.houses)return state.houses[definition.house_key]??null;
  return state.scene.house;
}

// 本地反馈使用服务端同一场景与目录；最终约束仍由原子保存复核。
export function layoutIssue(state: SpatialIslandState, placements: SpatialPlacement[]): LayoutIssue|null {
  const seen=new Set<string>();
  const placed=[];
  const houseGeometry=houseForPlacements(state,placements);
  for(const placement of placements){
    const definition=state.catalog.find(item=>item.item_key===placement.item_key);
    const owned=state.inventory.find(item=>item.instance_id===placement.instance_id&&item.item_key===placement.item_key);
    if(!definition || !owned || (owned.placed_scene_key&&owned.placed_scene_key!==state.scene_key) || seen.has(placement.instance_id)) return 'ownership';
    seen.add(placement.instance_id);
    if(!definition.spaces.includes(placement.space) || !definition.rotations.includes(placement.rotation) || ![placement.x_cm,placement.z_cm,placement.rotation].every(Number.isSafeInteger)) return 'boundary';
    const rect=spatialPlacementRect(placement,definition.footprint);
    if(placement.space==='outdoor') {
      if(!spatialFootprintCovered(placement,definition.footprint,state.scene.regions,definition.allowed_terrain)) return 'terrain';
      if(definition.blocks_placement&&state.scene.fixed_objects?.some(item=>item.blocks_placement&&spatialRectsOverlap(rect,spatialPlacementRect(item,item.footprint))))return 'overlap';
    } else {
      if(!houseGeometry)return 'house';
      const floor=houseGeometry.interior;
      if(rect.min_x_cm<floor.min_x_cm || rect.max_x_cm>floor.max_x_cm || rect.min_z_cm<floor.min_z_cm || rect.max_z_cm>floor.max_z_cm) return 'boundary';
      if(houseGeometry.walls.some(wall=>spatialRectsOverlap(rect,wall))) return 'wall';
      const obstacle=definition.walk_obstacle;
      if(obstacle&&houseGeometry.interior_clearances.some(clearance=>spatialRectsOverlap(spatialPlacementRect(placement,obstacle),clearance))) return 'door';
    }
    if(!definition.movable){
      const saved=state.placements.find(item=>item.instance_id===placement.instance_id);
      if(saved && JSON.stringify(saved)!==JSON.stringify(placement)) return 'fixed';
    }
    placed.push({placement,definition,rect});
  }
  const houses=placed.filter(item=>item.definition.assembly==='house');
  const selectedHouse=houses[0];
  if(houses.length>1 || (selectedHouse&&(selectedHouse.placement.space!=='outdoor'||selectedHouse.placement.rotation!==0||!houseGeometry))) return 'house';
  for(let index=0;index<placed.length;index++){
    const first=placed[index]!;
    if(placed.slice(index+1).some(other=>first.placement.space===other.placement.space && first.definition.blocks_placement && other.definition.blocks_placement && spatialRectsOverlap(first.rect,other.rect))) return 'overlap';
  }
  if(!selectedHouse||!houseGeometry)return null;
  const house=selectedHouse.placement,local=houseGeometry.door_clearance;
  const clearance:SpatialRect={min_x_cm:local.min_x_cm+house.x_cm,max_x_cm:local.max_x_cm+house.x_cm,min_z_cm:local.min_z_cm+house.z_cm,max_z_cm:local.max_z_cm+house.z_cm};
  if(!spatialRectCovered(clearance,state.scene.regions,selectedHouse.definition.allowed_terrain)) return 'door';
  if(placed.some(item=>item.placement.instance_id!==house.instance_id && item.placement.space==='outdoor' && item.definition.walk_obstacle && spatialRectsOverlap(clearance,spatialPlacementRect(item.placement,item.definition.walk_obstacle)))) return 'door';
  if(state.scene.fixed_objects?.some(item=>item.walk_obstacle&&spatialRectsOverlap(clearance,spatialPlacementRect(item,item.walk_obstacle))))return 'door';
  return null;
}

// 按小网格从中心向外寻找，找不到时保留库存而不插入无效物品。
export function firstAvailablePlacement(state:SpatialIslandState,placements:SpatialPlacement[],item:SpatialOwnedItem,space:SpatialSpace):SpatialPlacement|null {
  const definition=state.catalog.find(entry=>entry.item_key===item.item_key);
  if(!definition?.spaces.includes(space)||(item.placed_scene_key&&item.placed_scene_key!==state.scene_key)) return null;
  const limit=space==='indoor'?300:1500,step=space==='indoor'?20:50;
  const points:{x:number;z:number}[]=[];
  for(let x=-limit;x<=limit;x+=step) for(let z=-limit;z<=limit;z+=step) points.push({x,z});
  points.sort((a,b)=>a.x*a.x+a.z*a.z-b.x*b.x-b.z*b.z);
  for(const point of points){
    const candidate:SpatialPlacement={instance_id:item.instance_id,item_key:item.item_key,space,x_cm:point.x,z_cm:point.z,rotation:definition.rotations[0]??0};
    if(!layoutIssue(state,[...placements,candidate])) return candidate;
  }
  return null;
}
