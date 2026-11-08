import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { CharacterModel3D } from '../../character/CharacterModel3D';
import type { AppearanceState, CharacterLoadStatus } from '../../character/character3d-appearance';
import { useGraphicsMotion } from '../../../graphics/useGraphicsMotion';
import type { IslandAccess } from '../island-activity-access';
import { SpatialActorController, spatialBallPosition } from './spatial-actor';
import type { SpatialActorActivity, SpatialActorEnvironment, SpatialActorIntent, SpatialActorStatus, SpatialActorUnavailable } from './spatial-actor';
import type { SpatialLayout } from './spatial-navigation';
import { StaticModel } from './SpatialModels';

export type { SpatialActorIntent, SpatialActorStatus } from './spatial-actor';

/** 页面传命令与完整快照，人物位置只在当前Canvas内部逐帧修改。 */
export interface SpatialActor3DProps {
  layout:SpatialLayout; // 保存或取消后的最终布局，编辑时可传草稿。
  appearance:AppearanceState; // 与衣柜共用已保存形象。
  access:IslandAccess|null; // 独立资格快照。
  now:()=>number; // ApiClient 校准时钟。
  editing:boolean; // 编辑时冻结活动和布局重建。
  paused:boolean; // 用户暂停，内部再合并隐藏与减少动效。
  intent?:SpatialActorIntent; // 一次用户命令。
  onStatus?:(status:SpatialActorStatus)=>void; // 仅离散状态变化时调用。
  onUnavailable?:(reason:SpatialActorUnavailable,activity:SpatialActorActivity)=>void; // 页面配置负责提示文案。
  onCharacterStatus?:(status:CharacterLoadStatus)=>void; // 模型读取错误可接入页面重试提示。
  attempt?:number; // HTML重试入口递增代次，人物保留在同一个Canvas。
}

// 同一个控制器持续存在，React只在活动语义或所在空间变化时重渲染。
export function SpatialActor3D(props:SpatialActor3DProps) {
  const stopped=useGraphicsMotion(props.paused);
  const character=props.appearance.characters.find(item=>item.character_key===props.appearance.character_key);
  const actions=useMemo(()=>new Set(Object.keys(character?.animations??{})),[character]);
  const environment:SpatialActorEnvironment={layout:props.layout,access:props.access,now:props.now,editing:props.editing,paused:stopped,actions};
  const [actor]=useState(()=>new SpatialActorController(environment));
  const root=useRef<Group>(null),ball=useRef<Group>(null);
  const latest=useRef({environment,props});
  const sequence=useRef<number|undefined>(undefined),statusKey=useRef('');
  const modelReady=useRef(false),wasStopped=useRef(true);
  const [ballLoaded,setBallLoaded]=useState(false);
  const [visual,setVisual]=useState(()=>({action:actor.action,attachments:actor.attachments,status:actor.status}));

  useLayoutEffect(()=>{latest.current={environment,props};});

  // 每次发布前直接写场景变换，HTML状态更新不会承担角色运动。
  const publish=()=>{
    root.current?.position.set(actor.position.x_cm/100,actor.position.y_cm/100,actor.position.z_cm/100);
    if(root.current)root.current.rotation.y=actor.rotation;
    if(ball.current&&actor.ballTiming) {
      const point=spatialBallPosition(actor.elapsed,actor.ballTiming);ball.current.position.set(point[0],point[1],point[2]);
      ball.current.rotation.x=actor.elapsed*7;ball.current.rotation.z=actor.elapsed*3;
    }
    const key=JSON.stringify([actor.status,actor.action,actor.attachments]);
    if(key!==statusKey.current) {
      statusKey.current=key;setVisual({action:actor.action,attachments:actor.attachments,status:actor.status});
      latest.current.props.onStatus?.(actor.status);
    }
  };

  useLayoutEffect(()=>{
    actor.advance(0,environment);
    if(props.intent&&props.intent.sequence!==sequence.current) {
      sequence.current=props.intent.sequence;
      const reason=actor.request(props.intent,environment);
      if(reason)props.onUnavailable?.(reason,props.intent.activity);
    }
    publish();
  },[props.layout,props.access,props.now,props.editing,props.intent,stopped,actions]);

  useFrame((_,seconds)=>{
    const current=latest.current.environment;
    const frozen=current.paused||current.editing||!modelReady.current||(actor.status.phase==='performing'&&actor.status.activity==='ball'&&!ballLoaded);
    actor.advance(frozen||wasStopped.current?0:Math.min(seconds,0.1),{...current,paused:frozen});
    wasStopped.current=frozen;publish();
  },-1);

  // 人物资源尚未准备好时冻结执行时间，阅读不会在书加载期间被计为完成。
  const characterStatus=(status:CharacterLoadStatus)=>{
    modelReady.current=status.phase==='ready';
    latest.current.props.onCharacterStatus?.(status);
  };
  const playingBall=visual.status.phase==='performing'&&visual.status.activity==='ball';
  const ballAnimationTime=useCallback(()=>actor.ballTiming?actor.elapsed:0,[actor]);
  const target=playingBall?props.layout.placements.find(item=>item.instance_id===visual.status.targetInstanceId):undefined;
  const ballURL=target?props.layout.catalog.find(item=>item.item_key===target.item_key)?.model_url:undefined;
  useLayoutEffect(()=>{setBallLoaded(false);},[playingBall,ballURL]);
  const ballReady=useCallback(()=>{setBallLoaded(true);},[]);
  const ballError=useCallback((error:unknown)=>{latest.current.props.onCharacterStatus?.({phase:'error',error});},[]);
  return <group ref={root}>
    <CharacterModel3D snapshot={props.appearance} action={visual.action} animationTime={playingBall?ballAnimationTime:undefined} attachments={visual.attachments} paused={stopped||props.editing||(playingBall&&!ballLoaded)} onStatus={characterStatus} attempt={props.attempt??0}/>
    {playingBall&&ballURL?<group ref={ball}><group position={[0,-0.13,0]}><StaticModel url={ballURL} onReady={ballReady} onError={ballError}/></group></group>:null}
  </group>;
}
