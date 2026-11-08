import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrthographicCamera, Plane, Vector2, Vector3 } from 'three';
import type { CharacterLoadStatus, AppearanceState } from '../../character/character3d-appearance';
import type { IslandAccess } from '../island-activity-access';
import { SpatialActor3D } from './SpatialActor3D';
import type { SpatialActorActivity, SpatialActorIntent, SpatialActorStatus, SpatialActorUnavailable } from './spatial-actor';
import { cameraBasis, cameraTarget, dragCamera, groundFromWorld, snappedPlacement, zoomCamera } from './spatial-camera';
import type { SpatialCameraState, SpatialInsets } from './spatial-camera';
import { layoutIssue } from './spatial-layout';
import { SpatialHouseModel, StaticModel } from './SpatialModels';
import { SpatialTerrain } from './SpatialTerrain';
import type { SpatialIslandState, SpatialPlacement } from './spatial-ui-types';

/** 场景只负责展示与指针数学，业务草稿和导航由 React 页面持有。 */
export interface SpatialScene3DProps {
  layout:SpatialIslandState; // 当前草稿或已确认布局。
  appearance:AppearanceState|null; // 全站共用人物外观。
  access:IslandAccess|null; // 独立资格快照。
  now:()=>number; // 校准的业务时钟。
  camera:MutableRefObject<SpatialCameraState>; // 帧内相机不触发页面更新。
  insets:SpatialInsets; // HTML浮层占用。
  direction:number; // 只有切换四向时才更新的剖墙状态。
  editing:boolean; // 编辑时物件拖放，浏览时拖镜头。
  indoor:boolean; // 编辑查看或角色在屋内。
  paused:boolean; // 显式暂停与偏好。
  selected:string|null; // 当前库存实例。
  invalid:boolean; // 完整占地拒绝反馈。
  hiddenInstanceId?:string; // 玩球时交给角色表现同一物件。
  intent?:SpatialActorIntent; // 手动活动序列。
  onStatus:(status:SpatialActorStatus)=>void; // 只有活动状态变化通知页面。
  onUnavailable:(reason:SpatialActorUnavailable,activity:SpatialActorActivity)=>void; // HTML原因说明。
  onSelect:(instanceId:string)=>void; // 实际mesh选择。
  onObject:(instanceId:string)=>void; // 浏览点击互动。
  onPlacement:(placement:SpatialPlacement)=>void; // 指针移动的整数厘米草稿。
  onRejected:()=>void; // 无效落点恢复后提示。
  onError:(error:unknown)=>void; // 模型加载错误。
  onCharacterStatus:(status:CharacterLoadStatus)=>void; // 页面提供加载状态与重试反馈。
}

// 正交相机保持固定俯角，所有输入共用同一画幅与像素换算。
function CameraRig({camera:state,insets,units}:{camera:MutableRefObject<SpatialCameraState>;insets:SpatialInsets;units:MutableRefObject<number>}){
  const {camera,size}=useThree();
  useFrame(()=>{
    if(!(camera instanceof OrthographicCamera))return;
    const availableWidth=Math.max(180,size.width-insets.left-insets.right),availableHeight=Math.max(180,size.height-insets.top-insets.bottom);
    const scale=Math.max(39/availableWidth,32/availableHeight)/state.current.zoom;units.current=scale;
    const target=cameraTarget(state.current,insets,scale),{forward}=cameraBasis(state.current.direction);
    camera.left=-size.width*scale/2;camera.right=size.width*scale/2;camera.top=size.height*scale/2;camera.bottom=-size.height*scale/2;
    camera.position.set(target[0]+forward[0]*35,28,target[2]+forward[1]*35);camera.lookAt(...target);camera.updateProjectionMatrix();
  });
  return null;
}

/** 一次指针序列只属于物件拖动、镜头平移或双指缩放。 */
interface PointerGesture {
  mode:'pan'|'object'|'pinch'; // 第二根手指优先转为缩放。
  x:number; // 上次屏幕横坐标。
  y:number; // 上次屏幕纵坐标。
  distance:number; // 双指距离。
  original?:SpatialPlacement; // 无效或取消拖动时恢复。
  offset?:{x:number;z:number}; // 抓取点到模型原点的差。
}

// 原生移动监听配合真实mesh的pointerdown，不增加透明拾取盒。
function useSceneGestures(props:SpatialScene3DProps,units:MutableRefObject<number>){
  const {gl,camera,raycaster}=useThree();
  const latest=useRef(props);latest.current=props;
  const pointers=useRef(new Map<number,{x:number;y:number}>());
  const gesture=useRef<PointerGesture|null>(null);
  const click=useRef({blocked:false,x:0,y:0}); // 拖动和双指缩放完成后不能误触物件活动。
  const house=props.layout.placements.find(item=>props.layout.catalog.find(d=>d.item_key===item.item_key)?.assembly==='house');
  const floor=(space:'indoor'|'outdoor')=>space==='indoor'?(props.layout.scene.house?.floor_height_cm??0)/100:0;
  function worldPoint(clientX:number,clientY:number,height:number){
    const rect=gl.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1),camera);
    return raycaster.ray.intersectPlane(new Plane(new Vector3(0,1,0),-height),new Vector3());
  }
  function down(event:ThreeEvent<PointerEvent>,placement?:SpatialPlacement){
    event.stopPropagation();const native=event.nativeEvent;
    if(pointers.current.size===0)click.current={blocked:false,x:native.clientX,y:native.clientY};
    pointers.current.set(native.pointerId,{x:native.clientX,y:native.clientY});gl.domElement.setPointerCapture(native.pointerId);
    if(pointers.current.size>=2){
      click.current.blocked=true;
      if(gesture.current?.original)props.onPlacement(gesture.current.original);
      const [a,b]=[...pointers.current.values()];gesture.current={mode:'pinch',x:0,y:0,distance:Math.hypot(a!.x-b!.x,a!.y-b!.y)};return;
    }
    if(placement&&props.editing){
      props.onSelect(placement.instance_id);
      const definition=props.layout.catalog.find(item=>item.item_key===placement.item_key);
      if(!definition?.movable)return;
      const point=worldPoint(native.clientX,native.clientY,floor(placement.space));
      if(placement.space==='indoor'&&!house)return;
      const local=point?groundFromWorld(point,placement.space,house??placement):placement;
      gesture.current={mode:'object',x:native.clientX,y:native.clientY,distance:0,original:placement,offset:{x:local.x_cm-placement.x_cm,z:local.z_cm-placement.z_cm}};
    }else gesture.current={mode:'pan',x:native.clientX,y:native.clientY,distance:0};
  }
  useEffect(()=>{
    const element=gl.domElement;
    const move=(event:PointerEvent)=>{
      if(!pointers.current.has(event.pointerId))return;
      pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(Math.hypot(event.clientX-click.current.x,event.clientY-click.current.y)>4)click.current.blocked=true;
      const active=gesture.current;if(!active)return;
      if(active.mode==='pinch'){
        const [a,b]=[...pointers.current.values()];if(!a||!b)return;
        const distance=Math.hypot(a.x-b.x,a.y-b.y);
        if(active.distance>0)latest.current.camera.current=zoomCamera(latest.current.camera.current,distance/active.distance);
        active.distance=distance;return;
      }
      if(active.mode==='pan')latest.current.camera.current=dragCamera(latest.current.camera.current,event.clientX-active.x,event.clientY-active.y,units.current);
      else if(active.original){
        const current=latest.current,original=active.original,home=current.layout.placements.find(p=>current.layout.catalog.find(d=>d.item_key===p.item_key)?.assembly==='house');
        if(original.space==='indoor'&&!home)return;
        const height=original.space==='indoor'?(current.layout.scene.house?.floor_height_cm??0)/100:0;
        const point=worldPoint(event.clientX,event.clientY,height);
        if(point){const local=groundFromWorld(point,original.space,home??original);current.onPlacement({...original,...snappedPlacement({x_cm:local.x_cm-(active.offset?.x??0),z_cm:local.z_cm-(active.offset?.z??0)})});}
      }
      active.x=event.clientX;active.y=event.clientY;
    };
    const end=(event:PointerEvent)=>{
      if(!pointers.current.has(event.pointerId))return;
      pointers.current.delete(event.pointerId);const active=gesture.current;
      if(active?.original&&(event.type==='pointercancel'||layoutIssue(latest.current.layout,latest.current.layout.placements))){latest.current.onPlacement(active.original);if(event.type!=='pointercancel')latest.current.onRejected();}
      const remaining=[...pointers.current.values()][0];gesture.current=remaining?{mode:'pan',x:remaining.x,y:remaining.y,distance:0}:null;
      if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);
    };
    const wheel=(event:WheelEvent)=>{event.preventDefault();latest.current.camera.current=zoomCamera(latest.current.camera.current,Math.exp(-event.deltaY*.0015));};
    element.addEventListener('pointermove',move);element.addEventListener('pointerup',end);element.addEventListener('pointercancel',end);element.addEventListener('wheel',wheel,{passive:false});
    return()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',end);element.removeEventListener('wheel',wheel);};
  },[gl,camera,raycaster,units]);
  return {down,canClick:()=>!click.current.blocked};
}

// 深度测试由 Three.js 统一处理，选中占地仅作反馈且不参与拾取。
function IslandWorld(props:SpatialScene3DProps){
  const units=useRef(.05),{down,canClick}=useSceneGestures(props,units);
  const house=props.layout.placements.find(item=>props.layout.catalog.find(d=>d.item_key===item.item_key)?.assembly==='house');
  const geometry=props.layout.scene.house;
  const dusk=props.layout.environment_key==='dusk';
  return <>
    <color attach="background" args={[dusk?'#d9bba7':'#b8e2ee']}/><fog attach="fog" args={[dusk?'#d9bba7':'#b8e2ee',48,65]}/>
    <hemisphereLight args={[dusk?'#ffdfc4':'#fff8dc','#9ca785',2]}/>
    <directionalLight position={[-9,18,12]} intensity={dusk?2:2.5} color={dusk?'#ffd0a2':'#fff4dc'} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-25} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} shadow-normalBias={.025}/>
    <CameraRig camera={props.camera} insets={props.insets} units={units}/>
    <SpatialTerrain state={props.layout} paused={props.paused||props.editing} onPointerDown={event=>down(event)}/>
    {(props.layout.scene.fixed_objects??[]).map(object=><group key={object.key} position={[object.x_cm/100,0,object.z_cm/100]} rotation={[0,-object.rotation*Math.PI/2,0]}>
      <StaticModel url={object.model_url} scale={object.scale} onError={props.onError}/>
    </group>)}
    {props.layout.placements.map(placement=>{
      const definition=props.layout.catalog.find(item=>item.item_key===placement.item_key);if(!definition||placement.instance_id===props.hiddenInstanceId)return null;
      if(placement.space==='indoor'&&(!props.indoor||!house||!geometry))return null;
      const indoor=placement.space==='indoor',selected=props.selected===placement.instance_id;
      const x=(placement.x_cm+(indoor?(house?.x_cm??0):0))/100,z=(placement.z_cm+(indoor?(house?.z_cm??0):0))/100,y=indoor?(geometry?.floor_height_cm??0)/100:0;
      return <group key={placement.instance_id} position={[x,y,z]} rotation={[0,-placement.rotation*Math.PI/2,0]} onPointerDown={event=>down(event,placement)} onClick={event=>{event.stopPropagation();if(!props.editing&&canClick())props.onObject(placement.instance_id);}}>
        {definition.assembly==='house'?(geometry?<SpatialHouseModel house={geometry} direction={props.direction} open={props.indoor} onError={props.onError}/>:null):definition.model_url?<StaticModel url={definition.model_url} onError={props.onError}/>:null}
        {selected&&props.editing&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,.025,0]} raycast={()=>{}}><planeGeometry args={[definition.footprint.width_cm/100,definition.footprint.depth_cm/100]}/><meshBasicMaterial color={props.invalid?'#d73545':'#f3b839'} transparent opacity={.38} depthWrite={false}/></mesh>}
      </group>;
    })}
    {props.appearance&&<SpatialActor3D key={props.layout.scene_key} layout={props.layout} appearance={props.appearance} access={props.access} now={props.now} editing={props.editing} paused={props.paused} {...(props.intent?{intent:props.intent}:{})} onStatus={props.onStatus} onUnavailable={props.onUnavailable} onCharacterStatus={props.onCharacterStatus}/>}
  </>;
}

// HUD留在Canvas外，字体与按钮不随镜头缩放。
export function SpatialScene3D(props:SpatialScene3DProps){
  return <Canvas orthographic shadows dpr={[1,2]} camera={{position:[18,28,18],near:.1,far:220}} gl={{antialias:true,alpha:false}}><IslandWorld {...props}/></Canvas>;
}
