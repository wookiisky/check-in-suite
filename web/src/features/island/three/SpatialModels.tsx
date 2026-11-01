import { useEffect, useMemo, useState } from 'react';
import { Box3, Mesh, Vector3 } from 'three';
import type { Object3D } from 'three';
import { characterResources } from '../../../graphics/gltf-resources';
import type { SpatialHouse } from './spatial-ui-types';
import { hiddenWallSides } from './spatial-camera';
import type { WallSide } from './spatial-camera';
import type { SpatialRect } from '../spatial-geometry';

/** 静态物件使用共享 GLB 缓存，实例仅持有节点和变换。 */
interface StaticModelProps {
  url:string; // 目录中的同源真实模型。
  position?:[number,number,number]; // 米制父空间位置。
  fit?:[number,number,number]; // 建筑构件精确匹配共享物理体积。
  onError?:(error:unknown)=>void; // HTML反馈由页面显示。
  onReady?:()=>void; // 角色道具等需要等实际加载完成再推进。
  rotationY?:number; // 建筑长墙先沿自身纵向缩放，再转到共享轴向。
}

// 建筑构件可伸缩，普通家具保留发布时的米制比例。
export function StaticModel({url,position=[0,0,0],fit,onError,onReady,rotationY=0}:StaticModelProps){
  const [source,setSource]=useState<Object3D|null>(null);
  useEffect(()=>{
    let active=true;const lease=characterResources.acquire(url);
    void lease.ready.then(model=>{if(active){setSource(model.scene);onReady?.();}}).catch(error=>{if(active)onError?.(error);});
    return()=>{active=false;lease.release();};
  },[url,onError,onReady]);
  const object=useMemo(()=>{
    if(!source)return null;
    const result=source.clone(true);result.traverse(node=>{if(node instanceof Mesh){node.castShadow=true;node.receiveShadow=true;}});
    if(fit){
      const bounds=new Box3().setFromObject(result),size=bounds.getSize(new Vector3()),center=bounds.getCenter(new Vector3());
      result.scale.set(fit[0]/size.x,fit[1]/size.y,fit[2]/size.z);
      result.position.set(-center.x*result.scale.x,-bounds.min.y*result.scale.y,-center.z*result.scale.z);
    }
    return result;
  },[source,fit?.[0],fit?.[1],fit?.[2]]);
  return object?<group position={position} rotation={[0,rotationY,0]}><primitive object={object} dispose={null}/></group>:null;
}

// 内墙面向主活动区，外墙面向房屋外侧；两者都用真实 x/z 决定剖切方向。
export function houseWallSide(wall:SpatialRect,house:SpatialHouse):WallSide{
  const floor=house.interior;
  if(wall.min_x_cm===floor.min_x_cm)return 'west';
  if(wall.max_x_cm===floor.max_x_cm && wall.max_z_cm-wall.min_z_cm>wall.max_x_cm-wall.min_x_cm)return 'east';
  if(wall.min_z_cm===floor.min_z_cm)return 'north';
  if(wall.max_z_cm===floor.max_z_cm)return 'south';
  if(wall.max_x_cm-wall.min_x_cm<wall.max_z_cm-wall.min_z_cm)return (wall.min_x_cm+wall.max_x_cm)>0?'west':'east';
  return (wall.min_z_cm+wall.max_z_cm)>0?'north':'south';
}

// 房屋模型尺寸直接来自共享墙体和门洞，室内家具与导航使用同一范围。
export function SpatialHouseModel({house,direction,open,onError}:{house:SpatialHouse;direction:number;open:boolean;onError:(error:unknown)=>void}){
  const hidden=hiddenWallSides(direction,open),floor=house.interior;
  const width=(floor.max_x_cm-floor.min_x_cm)/100,depth=(floor.max_z_cm-floor.min_z_cm)/100,y=house.floor_height_cm/100,height=house.wall_height_cm/100;
  const cx=(floor.min_x_cm+floor.max_x_cm)/200,cz=(floor.min_z_cm+floor.max_z_cm)/200;
  const door=house.door_center,lintel=(house.wall_height_cm-house.door_height_cm)/100;
  return <group name="spatial-house">
    <StaticModel url={house.models.floor_url} position={[cx,0,cz]} fit={[width,y,depth]} onError={onError}/>
    {house.walls.map((wall,index)=>hidden.includes(houseWallSide(wall,house))?null:<StaticModel key={index} url={house.models.wall_url} position={[(wall.min_x_cm+wall.max_x_cm)/200,y,(wall.min_z_cm+wall.max_z_cm)/200]} rotationY={wall.max_x_cm-wall.min_x_cm>wall.max_z_cm-wall.min_z_cm?Math.PI/2:0} fit={[Math.min(wall.max_x_cm-wall.min_x_cm,wall.max_z_cm-wall.min_z_cm)/100,height,Math.max(wall.max_x_cm-wall.min_x_cm,wall.max_z_cm-wall.min_z_cm)/100]} onError={onError}/>)}
    {!hidden.includes('south')&&lintel>0&&<StaticModel url={house.models.wall_url} position={[door.x_cm/100,y+house.door_height_cm/100,door.z_cm/100-.05]} rotationY={Math.PI/2} fit={[.1,lintel,house.door_width_cm/100]} onError={onError}/>}
    {!open&&<StaticModel url={house.models.roof_url} position={[cx,y+height,cz]} fit={[width+.25,.28,depth+.25]} onError={onError}/>}
  </group>;
}
