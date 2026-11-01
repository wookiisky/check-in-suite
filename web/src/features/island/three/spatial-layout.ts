import { spatialFootprintCovered, spatialPlacementRect, spatialRectsOverlap } from '../spatial-geometry';
import type { SpatialRect } from '../spatial-geometry';
import type { SpatialIslandState, SpatialOwnedItem, SpatialPlacement, SpatialSpace } from './spatial-ui-types';

export type LayoutIssue='ownership'|'house'|'terrain'|'boundary'|'wall'|'door'|'overlap'|'fixed';

// 本地反馈使用服务端同一场景与目录；最终约束仍由原子保存复核。
export function layoutIssue(state: SpatialIslandState, placements: SpatialPlacement[]): LayoutIssue|null {
  const seen=new Set<string>();
  const placed=[];
  for(const placement of placements){
    const definition=state.catalog.find(item=>item.item_key===placement.item_key);
    if(!definition || !state.inventory.some(item=>item.instance_id===placement.instance_id && item.item_key===placement.item_key) || seen.has(placement.instance_id)) return 'ownership';
    seen.add(placement.instance_id);
    if(!definition.spaces.includes(placement.space) || !definition.rotations.includes(placement.rotation) || ![placement.x_cm,placement.z_cm,placement.rotation].every(Number.isSafeInteger)) return 'boundary';
    const rect=spatialPlacementRect(placement,definition.footprint);
    if(placement.space==='outdoor') {
      if(!spatialFootprintCovered(placement,definition.footprint,state.scene.regions,definition.allowed_terrain)) return 'terrain';
    } else {
      const floor=state.scene.house.interior;
      if(rect.min_x_cm<floor.min_x_cm || rect.max_x_cm>floor.max_x_cm || rect.min_z_cm<floor.min_z_cm || rect.max_z_cm>floor.max_z_cm) return 'boundary';
      if(state.scene.house.walls.some(wall=>spatialRectsOverlap(rect,wall))) return 'wall';
      if(definition.walk_obstacle && state.scene.house.interior_clearances.some(clearance=>spatialRectsOverlap(spatialPlacementRect(placement,definition.walk_obstacle!),clearance))) return 'door';
    }
    if(!definition.movable){
      const saved=state.placements.find(item=>item.instance_id===placement.instance_id);
      if(saved && JSON.stringify(saved)!==JSON.stringify(placement)) return 'fixed';
    }
    placed.push({placement,definition,rect});
  }
  const houses=placed.filter(item=>item.definition.assembly==='house');
  if(houses.length!==1 || houses[0]!.placement.space!=='outdoor' || houses[0]!.placement.rotation!==0) return 'house';
  for(let index=0;index<placed.length;index++){
    const first=placed[index]!;
    if(placed.slice(index+1).some(other=>first.placement.space===other.placement.space && first.definition.blocks_placement && other.definition.blocks_placement && spatialRectsOverlap(first.rect,other.rect))) return 'overlap';
  }
  const house=houses[0]!.placement,local=state.scene.house.door_clearance;
  const clearance:SpatialRect={min_x_cm:local.min_x_cm+house.x_cm,max_x_cm:local.max_x_cm+house.x_cm,min_z_cm:local.min_z_cm+house.z_cm,max_z_cm:local.max_z_cm+house.z_cm};
  const center={x_cm:(clearance.min_x_cm+clearance.max_x_cm)/2,z_cm:(clearance.min_z_cm+clearance.max_z_cm)/2,rotation:0};
  if(!spatialFootprintCovered(center,{width_cm:clearance.max_x_cm-clearance.min_x_cm,depth_cm:clearance.max_z_cm-clearance.min_z_cm},state.scene.regions,houses[0]!.definition.allowed_terrain)) return 'door';
  if(placed.some(item=>item.placement.instance_id!==house.instance_id && item.placement.space==='outdoor' && item.definition.walk_obstacle && spatialRectsOverlap(clearance,spatialPlacementRect(item.placement,item.definition.walk_obstacle)))) return 'door';
  return null;
}

// 按小网格从中心向外寻找，找不到时保留库存而不插入无效物品。
export function firstAvailablePlacement(state:SpatialIslandState,placements:SpatialPlacement[],item:SpatialOwnedItem,space:SpatialSpace):SpatialPlacement|null {
  const definition=state.catalog.find(entry=>entry.item_key===item.item_key);
  if(!definition?.spaces.includes(space)) return null;
  const limit=space==='indoor'?300:1500,step=space==='indoor'?20:50;
  const points:{x:number;z:number}[]=[];
  for(let x=-limit;x<=limit;x+=step) for(let z=-limit;z<=limit;z+=step) points.push({x,z});
  points.sort((a,b)=>a.x*a.x+a.z*a.z-b.x*b.x-b.z*b.z);
  for(const point of points){
    const candidate:SpatialPlacement={...item,space,x_cm:point.x,z_cm:point.z,rotation:definition.rotations[0]??0};
    if(!layoutIssue(state,[...placements,candidate])) return candidate;
  }
  return null;
}
