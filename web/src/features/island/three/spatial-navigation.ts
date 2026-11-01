import type { components } from '../../../api/schema';
import { spatialFootprintCovered, spatialPlacementRect } from '../spatial-geometry';
import type { SpatialPoint, SpatialRect } from '../spatial-geometry';

export type SpatialLayout = components['schemas']['SpatialIslandState'];
export type SpatialPlacement = components['schemas']['SpatialPlacement'];
export type SpatialSpace = components['schemas']['SpatialSpace'];
export const ACTOR_RADIUS_CM = 35;
const GRID_CM = 10;

/** 导航只持有当前完整布局，不依赖相机或旧投影。 */
export interface SpatialNavigation {
  house: SpatialPlacement; // 室内局部坐标的世界锚点。
  walkable: (point: SpatialPoint) => boolean; // 整个身体必须留在陆地且不碰障碍。
  path: (start: SpatialPoint, end: SpatialPoint) => SpatialPoint[] | null; // 返回包含真实终点的世界路径。
  nearest: (point: SpatialPoint) => SpatialPoint; // 布局变更后寻找最近有效落点。
  space: (point: SpatialPoint) => SpatialSpace; // 根据房屋实际地板判断空间。
  randomPoint: (space: SpatialSpace, random: () => number) => SpatialPoint | null; // 不保证与当前位置连通。
}

// 保存朝向顺时针旋转四分之一圈，和 Three 的负 Y 旋转一致。
export function spatialLocalToWorld(point: SpatialPoint, transform: {x_cm:number;z_cm:number;rotation:number}): SpatialPoint {
  const turns=((transform.rotation%4)+4)%4;
  const rotated=turns===0?point:turns===1?{x_cm:-point.z_cm,z_cm:point.x_cm}:turns===2?{x_cm:-point.x_cm,z_cm:-point.z_cm}:{x_cm:point.z_cm,z_cm:-point.x_cm};
  return {x_cm:transform.x_cm+rotated.x_cm,z_cm:transform.z_cm+rotated.z_cm};
}

// 主屋方向当前固定零；保留通用逆变换以统一室内目标计算。
export function spatialWorldToLocal(point: SpatialPoint, transform: SpatialPlacement): SpatialPoint {
  return spatialLocalToWorld({x_cm:point.x_cm-transform.x_cm,z_cm:point.z_cm-transform.z_cm},{x_cm:0,z_cm:0,rotation:-transform.rotation});
}

// 墙和家具均以真实阻挡定义膨胀身体半径，不能使用摆放占地代替。
export function createSpatialNavigation(layout: SpatialLayout): SpatialNavigation {
  const definitions=new Map(layout.catalog.map(item=>[item.item_key,item]));
  const house=layout.placements.find(item=>definitions.get(item.item_key)?.assembly==='house')!;
  const obstacles:SpatialRect[]=layout.scene.house.walls.map(rect=>({
    min_x_cm:rect.min_x_cm+house.x_cm,max_x_cm:rect.max_x_cm+house.x_cm,
    min_z_cm:rect.min_z_cm+house.z_cm,max_z_cm:rect.max_z_cm+house.z_cm,
  }));
  for (const placement of layout.placements) {
    const definition=definitions.get(placement.item_key);
    if (!definition?.walk_obstacle || definition.assembly==='house') continue;
    const world=placement.space==='indoor'?spatialLocalToWorld(placement,house):placement;
    obstacles.push(spatialPlacementRect({...world,rotation:placement.rotation+ (placement.space==='indoor'?house.rotation:0)},definition.walk_obstacle));
  }
  const vertices=layout.scene.regions.filter(region=>region.terrain!=='water').flatMap(region=>region.polygon);
  const minX=Math.min(...vertices.map(point=>point.x_cm)),maxX=Math.max(...vertices.map(point=>point.x_cm));
  const minZ=Math.min(...vertices.map(point=>point.z_cm)),maxZ=Math.max(...vertices.map(point=>point.z_cm));
  const cache=new Map<string,boolean>();
  const walkable=(point:SpatialPoint):boolean=>{
    if (point.x_cm<minX+ACTOR_RADIUS_CM||point.x_cm>maxX-ACTOR_RADIUS_CM||point.z_cm<minZ+ACTOR_RADIUS_CM||point.z_cm>maxZ-ACTOR_RADIUS_CM) return false;
    if (obstacles.some(rect=>point.x_cm>rect.min_x_cm-ACTOR_RADIUS_CM&&point.x_cm<rect.max_x_cm+ACTOR_RADIUS_CM&&point.z_cm>rect.min_z_cm-ACTOR_RADIUS_CM&&point.z_cm<rect.max_z_cm+ACTOR_RADIUS_CM)) return false;
    // 渲染插值允许小数；向外扩一厘米，避免四舍五入把岸外身体放行。
    const x=Math.round(point.x_cm),z=Math.round(point.z_cm),margin=Number.isInteger(point.x_cm)&&Number.isInteger(point.z_cm)?0:1,key=`${x},${z},${margin}`;
    let valid=cache.get(key);
    if (valid===undefined) {
      valid=spatialFootprintCovered({x_cm:x,z_cm:z,rotation:0},{width_cm:(ACTOR_RADIUS_CM+margin)*2,depth_cm:(ACTOR_RADIUS_CM+margin)*2},layout.scene.regions,['grass','sand']);
      cache.set(key,valid);
    }
    return valid;
  };
  const segment=(a:SpatialPoint,b:SpatialPoint):boolean=>{
    const steps=Math.ceil(Math.hypot(b.x_cm-a.x_cm,b.z_cm-a.z_cm)/5);
    for(let i=0;i<=steps;i++) if(!walkable({x_cm:a.x_cm+(b.x_cm-a.x_cm)*i/(steps||1),z_cm:a.z_cm+(b.z_cm-a.z_cm)*i/(steps||1)})) return false;
    return true;
  };
  const grid=(point:SpatialPoint):SpatialPoint=>({x_cm:house.x_cm+Math.round((point.x_cm-house.x_cm)/GRID_CM)*GRID_CM,z_cm:house.z_cm+Math.round((point.z_cm-house.z_cm)/GRID_CM)*GRID_CM});
  const connectedGrid=(point:SpatialPoint):SpatialPoint|null=>{
    const center=grid(point);
    for(let r=0;r<=5;r++) for(let x=-r;x<=r;x++) for(let z=-r;z<=r;z++) {
      if(Math.max(Math.abs(x),Math.abs(z))!==r)continue;
      const candidate={x_cm:center.x_cm+x*GRID_CM,z_cm:center.z_cm+z*GRID_CM};
      if(segment(point,candidate))return candidate;
    }
    return null;
  };
  const key=(point:SpatialPoint)=>`${point.x_cm},${point.z_cm}`;
  const path=(start:SpatialPoint,end:SpatialPoint):SpatialPoint[]|null=>{
    if(!walkable(start)||!walkable(end))return null;
    if(segment(start,end))return [start,end];
    const first=connectedGrid(start),last=connectedGrid(end);
    if(!first||!last)return null;
    const open=new MinHeap(),cost=new Map<string,number>(),parents=new Map<string,SpatialPoint>();
    const estimate=(point:SpatialPoint)=>Math.abs(point.x_cm-last.x_cm)+Math.abs(point.z_cm-last.z_cm);
    open.push(first,estimate(first));cost.set(key(first),0);
    const closed=new Set<string>();
    while(open.length) {
      const current=open.pop()!,currentKey=key(current);
      if(closed.has(currentKey))continue;
      closed.add(currentKey);
      if(currentKey===key(last)) {
        const result=[end,current];let cursor=current;
        while(parents.has(key(cursor))) {cursor=parents.get(key(cursor))!;result.push(cursor);}
        result.push(start);return result.reverse();
      }
      for(const [dx,dz] of [[GRID_CM,0],[-GRID_CM,0],[0,GRID_CM],[0,-GRID_CM]]) {
        const next={x_cm:current.x_cm+dx!,z_cm:current.z_cm+dz!},nextKey=key(next);
        if(closed.has(nextKey)||!segment(current,next))continue;
        const nextCost=cost.get(currentKey)!+GRID_CM;
        if(nextCost>=(cost.get(nextKey)??Infinity))continue;
        cost.set(nextKey,nextCost);parents.set(nextKey,current);open.push(next,nextCost+estimate(next));
      }
    }
    return null;
  };
  const space=(point:SpatialPoint):SpatialSpace=>{
    const local=spatialWorldToLocal(point,house),interior=layout.scene.house.interior;
    return local.x_cm>=interior.min_x_cm&&local.x_cm<=interior.max_x_cm&&local.z_cm>=interior.min_z_cm&&local.z_cm<=interior.max_z_cm?'indoor':'outdoor';
  };
  const nearest=(point:SpatialPoint):SpatialPoint=>{
    if(walkable(point))return point;
    const center=grid(point);
    if(walkable(center))return center;
    for(let r=1;r<=400;r++)for(let x=-r;x<=r;x++)for(const z of [-r,r]) {
      const candidate={x_cm:center.x_cm+x*GRID_CM,z_cm:center.z_cm+z*GRID_CM};if(walkable(candidate))return candidate;
      const other={x_cm:center.x_cm+z*GRID_CM,z_cm:center.z_cm+x*GRID_CM};if(walkable(other))return other;
    }
    return {x_cm:house.x_cm,z_cm:house.z_cm+450};
  };
  const randomPoint=(desired:SpatialSpace,random:()=>number):SpatialPoint|null=>{
    const bounds=layout.scene.house.interior;
    for(let i=0;i<80;i++) {
      const point=desired==='indoor'?spatialLocalToWorld({x_cm:Math.round(bounds.min_x_cm+random()*(bounds.max_x_cm-bounds.min_x_cm)),z_cm:Math.round(bounds.min_z_cm+random()*(bounds.max_z_cm-bounds.min_z_cm))},house):{x_cm:Math.round(minX+random()*(maxX-minX)),z_cm:Math.round(minZ+random()*(maxZ-minZ))};
      if(space(point)===desired&&walkable(point))return point;
    }
    return null;
  };
  return {house,walkable,path,space,nearest,randomPoint};
}

/** A* 的最小堆避免大场景每一步线性扫描待访问节点。 */
class MinHeap {
  private nodes:{point:SpatialPoint;priority:number}[]=[]; // 每个待访问节点与估价。
  get length() {return this.nodes.length;}
  // 按估价上浮新节点。
  push(point:SpatialPoint,priority:number) {
    this.nodes.push({point,priority});let index=this.nodes.length-1;
    while(index>0) {const parent=Math.floor((index-1)/2);if(this.nodes[parent]!.priority<=priority)break;[this.nodes[parent],this.nodes[index]]=[this.nodes[index]!,this.nodes[parent]!];index=parent;}
  }
  // 取出估价最小的世界节点。
  pop():SpatialPoint|undefined {
    const first=this.nodes[0],last=this.nodes.pop();if(!first)return undefined;
    if(this.nodes.length&&last) {this.nodes[0]=last;let index=0;
      while(true) {const left=index*2+1,right=left+1;let smallest=index;if(left<this.nodes.length&&this.nodes[left]!.priority<this.nodes[smallest]!.priority)smallest=left;if(right<this.nodes.length&&this.nodes[right]!.priority<this.nodes[smallest]!.priority)smallest=right;if(smallest===index)break;[this.nodes[index],this.nodes[smallest]]=[this.nodes[smallest]!,this.nodes[index]!];index=smallest;}
    }
    return first.point;
  }
}
