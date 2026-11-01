import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import type { Session } from '../../api/types';
import { Modal } from '../../components/Modal';
import { CurrencyAmount } from '../../components/CurrencyAmount';
import { useGraphicsMotion } from '../../graphics/useGraphicsMotion';
import type { CharacterLoadStatus } from '../character/character3d-appearance';
import { useAppearance } from '../character/AppearanceProvider';
import { TaskIcon } from '../checkin/TaskIcon';
import type { Camp } from '../shop/types';
import { useIslandActivityAccess } from './useIslandActivityAccess';
import { allowedIslandActivities } from './island-activity-access';
import { SpatialSceneBoundary } from './three/SpatialSceneBoundary';
import { SpatialScene3D } from './three/SpatialScene3D';
import { SpatialInventory } from './three/SpatialInventory';
import { ScenePicker } from './three/ScenePicker';
import type { SpatialSceneChoice } from './three/ScenePicker';
import { useSpatialLayout } from './three/useSpatialLayout';
import { firstAvailablePlacement, layoutIssue } from './three/spatial-layout';
import { dragCamera, zoomCamera } from './three/spatial-camera';
import type { SpatialCameraState, SpatialInsets } from './three/spatial-camera';
import type { SpatialPlacement, SpatialSpace } from './three/spatial-ui-types';
import type { SpatialActorActivity, SpatialActorIntent, SpatialActorStatus } from './three/spatial-actor';
import content from './three/spatial-content.json';
import sceneContent from './three/scene-picker-content.json';
import './three/spatial-island.css';

/** 页面复用应用会话与人物Provider，不创建另一套登录和装扮状态。 */
export interface IslandPage3DProps {
  client:Pick<ApiClient,'request'>&Partial<Pick<ApiClient,'now'|'recordServerTime'>>; // 当前登录的请求入口。
  session:Session; // 账户及减少动效偏好。
  onBack?:()=>void; // 返回进入营地前的页面。
  onShop?:(group?:'scene')=>void; // 场景购买入口可直接打开商店的场景分类。
  onCamp?:()=>void; // 进入已有打卡页面。
  onSettings?:()=>void; // 打开共享设置。
}
type Destination='back'|'shop'|'camp'|{sceneKey:string}|{shopGroup:'scene'};
const defaultSceneKey='seaside-v1';

// 页面只保存业务状态，人物和镜头的逐帧变化留在Canvas内部。
export function IslandPage3D({client,session,onBack,onShop,onCamp,onSettings}:IslandPage3DProps){
  const [sceneKey,setSceneKey]=useState(defaultSceneKey),[scenes,setScenes]=useState<SpatialSceneChoice[]>([]);
  const [scenePickerOpen,setScenePickerOpen]=useState(false),[scenesLoading,setScenesLoading]=useState(true),[scenesError,setScenesError]=useState<unknown>(null),[scenesAttempt,setScenesAttempt]=useState(0);
  const layout=useSpatialLayout(client,sceneKey),appearance=useAppearance(),access=useIslandActivityAccess(client);
  const currentLayout=useRef(layout);currentLayout.current=layout;
  const sceneRestored=useRef(false),sceneInteracted=useRef(false);
  const [camp,setCamp]=useState<Camp|null>(null),[campError,setCampError]=useState<unknown>(null);
  const [selected,setSelected]=useState<string|null>(null),[space,setSpace]=useState<SpatialSpace>('outdoor');
  const [panelOpen,setPanelOpen]=useState(true),[checkinsOpen,setCheckinsOpen]=useState(true);
  const [cameraOpen,setCameraOpen]=useState(()=>window.innerWidth>760);
  const [hudTop,setHudTop]=useState(100),[panelTop,setPanelTop]=useState(window.innerHeight);
  const [cameraPanOpen,setCameraPanOpen]=useState(()=>window.innerWidth>760);
  const [manualIndoor,setManualIndoor]=useState(false),[paused,setPaused]=useState(false),[direction,setDirection]=useState(0);
  const [intent,setIntent]=useState<SpatialActorIntent>(),[actor,setActor]=useState<SpatialActorStatus>({phase:'idle',activity:'rest',space:'outdoor'});
  const [locked,setLocked]=useState<SpatialActorActivity|null>(null),[leaving,setLeaving]=useState<Destination|null>(null);
  const [characterStatus,setCharacterStatus]=useState<CharacterLoadStatus>({phase:'loading'});
  const reportCharacter=useCallback((status:CharacterLoadStatus)=>{setCharacterStatus(status);if(status.phase==='error')setModelError(true);},[]);
  const [message,setMessage]=useState(''),[modelError,setModelError]=useState(false),[sceneAttempt,setSceneAttempt]=useState(0);
  const header=useRef<HTMLElement>(null),dock=useRef<HTMLElement>(null),panel=useRef<HTMLElement>(null),tasks=useRef<HTMLElement>(null),cameraControls=useRef<HTMLElement>(null);
  const camera=useRef<SpatialCameraState>({x:0,z:0,zoom:window.innerWidth<=760?2.6:2.2,direction:0});
  const [insets,setInsets]=useState<SpatialInsets>({top:110,right:20,bottom:110,left:20});
  const stopped=useGraphicsMotion(paused||session.account.preferences.reduce_motion);
  const now=useCallback(()=>client.now?.().getTime()??Date.now(),[client]);
  const sceneError=useCallback(()=>setModelError(true),[]);
  const view=layout.view,editing=layout.editing,indoor=!!layout.view?.scene.house&&(manualIndoor||actor.space==='indoor');
  const selection=view?.placements.find(item=>item.instance_id===selected);
  const issue=view?layoutIssue(view,view.placements):null;
  const busy=layout.saving||layout.unknownSave||layout.loading;
  const allowed=allowedIslandActivities(access.access,now());

  // 先读取永久资格，再恢复本设备选择；失效或未拥有的本地身份不会触发布局读取。
  useEffect(()=>{
    const controller=new AbortController();
    setScenesLoading(true);setScenesError(null);
    void client.request<{items:SpatialSceneChoice[]}>('/island/scenes',{signal:controller.signal}).then(next=>{
      if(controller.signal.aborted)return;
      setScenes(next.items);
      if(!sceneRestored.current){
        sceneRestored.current=true;
        let preferred:string|null=null;
        try{preferred=localStorage.getItem(sceneContent.storageKey);}catch{/* 存储被禁用时，当前页面仍可正常切换场景。 */}
        const target=next.items.find(item=>item.scene_key===preferred&&(item.owned||item.free));
        const before=currentLayout.current;
        if(target&&target.scene_key!==defaultSceneKey&&!sceneInteracted.current&&before.canLeave&&!before.dirty&&!before.conflict&&!before.review)navigate({sceneKey:target.scene_key});
      }
    }).catch(reason=>{if(!controller.signal.aborted)setScenesError(reason);}).finally(()=>{if(!controller.signal.aborted)setScenesLoading(false);});
    const refresh=()=>setScenesAttempt(value=>value+1);
    window.addEventListener('focus',refresh);
    return()=>{controller.abort();window.removeEventListener('focus',refresh);};
  },[client,scenesAttempt]);

  const lastActorSpace=useRef<SpatialSpace>('outdoor'); // 仅过门时自动取景，状态文字变化不拉回用户镜头。
  const outsideCamera=useRef<SpatialCameraState|null>(null); // 出屋时恢复进入前的浏览位置。
  useEffect(()=>{
    if(lastActorSpace.current===actor.space)return;
    lastActorSpace.current=actor.space;
    if(editing||!view)return;
    if(actor.space==='indoor'){
      outsideCamera.current={...camera.current};
      const house=view.placements.find(p=>view.catalog.find(d=>d.item_key===p.item_key)?.assembly==='house');
      if(house)camera.current={...camera.current,x:house.x_cm/100,z:house.z_cm/100,zoom:2.8};
    }else if(!manualIndoor&&outsideCamera.current)camera.current={...outsideCamera.current};
  },[actor.space,editing,view,manualIndoor]);

  // 每次回到页面重新读取打卡快照，不在这里计算另一套余额或任务。
  useEffect(()=>{
    let controller:AbortController|null=null;
    const refresh=()=>{
      controller?.abort();controller=new AbortController();const request=controller;
      void client.request<Camp>('/camp',{signal:request.signal}).then(next=>{if(!request.signal.aborted){client.recordServerTime?.(next.server_now);setCamp(next);setCampError(null);}}).catch(reason=>{if(!request.signal.aborted)setCampError(reason);});
    };
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    refresh();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{controller?.abort();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
  },[client]);

  // 列表在浮层内部滚动；只用实际边界为镜头保留看得见的空间。
  useLayoutEffect(()=>{
    const measure=()=>{
      const headerBottom=(header.current?.getBoundingClientRect().bottom??84)+12;setHudTop(headerBottom);
      const bottom=dock.current?Math.max(0,window.innerHeight-dock.current.getBoundingClientRect().top)+12:100;
      const bounds=editing?panel.current?.getBoundingClientRect():null;setPanelTop(bounds?.top??window.innerHeight);
      const desktop=window.innerWidth>760;
      const controls=cameraControls.current?.getBoundingClientRect();
      const top=desktop?headerBottom:Math.max(headerBottom,(controls?.bottom??0)+12,(tasks.current?.getBoundingClientRect().bottom??0)+12,editing?(dock.current?.getBoundingClientRect().bottom??0)+12:0);
      const next={top,left:desktop&&tasks.current?(tasks.current.getBoundingClientRect().right+12):12,right:desktop?Math.max(bounds?window.innerWidth-bounds.left+12:12,controls?window.innerWidth-controls.left+12:12):12,bottom:bounds&&!desktop?window.innerHeight-bounds.top+12:bottom};
      setInsets(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);
    };
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
    [header.current,dock.current,panel.current,tasks.current,cameraControls.current].forEach(node=>{if(node)observer?.observe(node);});
    window.addEventListener('resize',measure);measure();return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[editing,panelOpen,checkinsOpen,cameraOpen,cameraPanOpen,camp,view!==null]);
  useEffect(()=>{
    const unload=(event:BeforeUnloadEvent)=>{if(layout.dirty||layout.unknownSave){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);
  },[layout.dirty,layout.unknownSave]);

  // 三个离开入口共用同一流程，保存失败时不会执行导航回调。
  function navigate(destination:Destination){
    if(typeof destination==='string'){(destination==='back'?onBack:destination==='shop'?onShop:onCamp)?.();return;}
    if('shopGroup' in destination){onShop?.(destination.shopGroup);return;}
    setSceneKey(destination.sceneKey);setSelected(null);setSpace('outdoor');setManualIndoor(false);setIntent(undefined);setActor({phase:'idle',activity:'rest',space:'outdoor'});setMessage('');setModelError(false);setLocked(null);
    lastActorSpace.current='outdoor';outsideCamera.current=null;
    camera.current={x:0,z:0,zoom:window.innerWidth<=760?2.6:2.2,direction};
    try{localStorage.setItem(sceneContent.storageKey,destination.sceneKey);}catch{/* 场景布置由服务端保存，设备偏好写入失败不影响前往。 */}
  }
  function leave(destination:Destination){if(layout.saving)return;if(layout.dirty||layout.unknownSave||layout.conflict||layout.review){setLeaving(destination);return;}if(layout.editing)layout.cancel();navigate(destination);}
  async function save(destination?:Destination){if(await layout.save()){setMessage(content.saved);setSelected(null);if(destination){setLeaving(null);navigate(destination);}}}
  function discardLeave(){if(layout.unknownSave)return;layout.cancel();const destination=leaving;setLeaving(null);if(destination)navigate(destination);}
  function begin(){sceneInteracted.current=true;layout.begin();setMessage('');setSelected(null);setCheckinsOpen(false);setCameraOpen(false);setPanelOpen(true);}
  function cancel(){layout.cancel();setSelected(null);setMessage('');}

  // 切换室内只改变镜头与剖切，不改变已保存布局。
  function focusSpace(next:SpatialSpace,collapse=false){
    if(next==='indoor'&&!view?.scene.house){
      if(editing&&view?.placements.some(item=>item.space==='indoor')){setSpace('indoor');setManualIndoor(false);}
      return;
    }
    setSpace(next);setManualIndoor(next==='indoor');
    if(next==='indoor'&&view){const house=view.placements.find(p=>view.catalog.find(d=>d.item_key===p.item_key)?.assembly==='house');if(house)camera.current={...camera.current,x:house.x_cm/100,z:house.z_cm/100,zoom:2.8};if(collapse&&window.innerWidth<=760)setPanelOpen(false);}
    else camera.current={...camera.current,x:0,z:0,zoom:window.innerWidth<=760?2.6:2.2};
  }
  function choose(instanceId:string){
    if(!view||busy)return;
    let placement=view.placements.find(item=>item.instance_id===instanceId);
    if(!placement){
      const owned=view.inventory.find(item=>item.instance_id===instanceId);if(!owned)return;
      if(space==='indoor'&&!view.scene.house)return;
      if(owned.placed_scene_key&&owned.placed_scene_key!==view.scene_key)return;
      const replacingHouse=view.catalog.find(item=>item.item_key===owned.item_key)?.assembly==='house';
      const kept=replacingHouse?view.placements.filter(item=>view.catalog.find(definition=>definition.item_key===item.item_key)?.assembly!=='house'):view.placements;
      const search=replacingHouse?kept.filter(item=>item.space==='outdoor'):kept;
      placement=firstAvailablePlacement(view,search,owned,replacingHouse?'outdoor':space)??undefined;
      if(!placement){setMessage(content.noSpace);return;}
      layout.setPlacements([...kept,placement]);
    }
    setSelected(instanceId);setMessage('');if(window.innerWidth<=760)setPanelOpen(false);
    if(placement.space==='indoor')focusSpace('indoor',true);
    const house=view.placements.find(p=>view.catalog.find(d=>d.item_key===p.item_key)?.assembly==='house');
    if(placement.space==='indoor'&&!view.scene.house)return;
    camera.current={...camera.current,x:(placement.x_cm+(placement.space==='indoor'?(house?.x_cm??0):0))/100,z:(placement.z_cm+(placement.space==='indoor'?(house?.z_cm??0):0))/100};
  }
  function updatePlacement(placement:SpatialPlacement){if(view&&!busy)layout.setPlacements(view.placements.map(item=>item.instance_id===placement.instance_id?placement:item));}
  function nudge(dx:number,dz:number){if(selection)updatePlacement({...selection,x_cm:selection.x_cm+dx,z_cm:selection.z_cm+dz});}
  function rotateItem(){if(selection&&view){const definition=view.catalog.find(d=>d.item_key===selection.item_key)!;const rotation=(selection.rotation+1)%4;if(definition.rotations.includes(rotation))updatePlacement({...selection,rotation});}}
  function store(){if(selection&&view){const kept=view.placements.filter(item=>item.instance_id!==selected);layout.setPlacements(kept);setSelected(null);if(view.catalog.find(d=>d.item_key===selection.item_key)?.assembly==='house'||(!view.scene.house&&!kept.some(item=>item.space==='indoor')))focusSpace('outdoor');}}

  // 活动资格和走不到目标的提示都用HTML呈现，静态展示时也能得到反馈。
  function activity(activity:SpatialActorActivity,instanceId?:string){
    if(activity!=='walk'&&activity!=='rest'&&!allowed.includes(activity)){setLocked(activity);return;}
    setIntent(current=>({sequence:(current?.sequence??0)+1,activity,...(instanceId?{instanceId}:{})}));setMessage('');
  }
  function unavailable(reason:'locked'|'unreachable'|'missing_target',activity:SpatialActorActivity){if(reason==='locked')setLocked(activity);else setMessage(content[reason]);}
  function objectClick(instanceId:string){
    const placement=view?.placements.find(item=>item.instance_id===instanceId),definition=view?.catalog.find(d=>d.item_key===placement?.item_key);
    if(definition?.assembly==='house'){setIntent(current=>({sequence:(current?.sequence??0)+1,activity:'walk',space:actor.space==='indoor'?'outdoor':'indoor'}));return;}
    if(definition?.interaction)activity(definition.interaction.activity,instanceId);
  }
  function rotateCamera(delta:number){setDirection(current=>{const next=(current+delta+4)%4;camera.current={...camera.current,direction:next};return next;});}
  function pan(dx:number,dy:number){camera.current=dragCamera(camera.current,dx,dy,.05/camera.current.zoom);}
  function cameraKeys(event:React.KeyboardEvent<HTMLElement>){
    if(event.target!==event.currentTarget)return;
    const keys:Record<string,()=>void>={ArrowLeft:()=>pan(80,0),ArrowRight:()=>pan(-80,0),ArrowUp:()=>pan(0,80),ArrowDown:()=>pan(0,-80),'+':()=>{camera.current=zoomCamera(camera.current,1.2);},'=':()=>{camera.current=zoomCamera(camera.current,1.2);},'-':()=>{camera.current=zoomCamera(camera.current,1/1.2);},q:()=>rotateCamera(-1),e:()=>rotateCamera(1)};
    const action=keys[event.key];if(action){event.preventDefault();action();}
  }

  return <main className="spatial-island" aria-label={content.title} style={{'--spatial-hud-top':`${hudTop}px`,'--spatial-panel-top':`${panelTop}px`} as CSSProperties}>
    <section className="spatial-stage" aria-label={content.scene} aria-describedby="spatial-scene-help" data-camera-direction={direction} data-actor-space={actor.space} data-actor-phase={actor.phase} data-character-status={characterStatus.phase} tabIndex={0} onKeyDown={cameraKeys}>
      {view&&<SpatialSceneBoundary key={`${sceneKey}:${sceneAttempt}`} onError={sceneError}><SpatialScene3D layout={view} appearance={appearance.snapshot} access={access.access} now={now} camera={camera} insets={insets} direction={direction} editing={editing} indoor={indoor} paused={stopped||modelError} selected={selected} invalid={!!issue} {...(actor.phase==='performing'&&actor.activity==='ball'&&actor.targetInstanceId?{hiddenInstanceId:actor.targetInstanceId}:{})} {...(intent?{intent}:{})} onStatus={setActor} onUnavailable={unavailable} onSelect={id=>{if(!busy)setSelected(id);}} onObject={objectClick} onPlacement={updatePlacement} onRejected={()=>setMessage(content.invalid[issue??'boundary'])} onError={sceneError} onCharacterStatus={reportCharacter}/></SpatialSceneBoundary>}
    </section>
    <p className="spatial-sr-only" role="status">{content.characterStatus[characterStatus.phase]}</p>
    <p id="spatial-scene-help" className="spatial-sr-only">{content.sceneHelp}</p>
    <header ref={header} className="spatial-header">
      <button className="secondary spatial-back" aria-label={content.back} title={content.back} disabled={layout.saving} onClick={()=>leave('back')}><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <div className="spatial-heading"><h1>{scenes.find(item=>item.scene_key===sceneKey)?.name??content.title}</h1><button className="secondary spatial-scene-choice" disabled={layout.saving} onClick={()=>setScenePickerOpen(true)}>{sceneContent.open}</button></div>
      <button className="secondary spatial-camera-toggle" aria-label={cameraOpen?content.hideCamera:content.showCamera} aria-expanded={cameraOpen} aria-controls="spatial-camera-controls" onClick={()=>{setCameraOpen(value=>!value);if(!cameraOpen&&editing&&window.innerWidth<=760)setPanelOpen(false);}}><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M12 1v6m0 10v6M1 12h6m10 0h6" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg></button>
      <div className="spatial-header-end">{camp&&<section className="spatial-wallet" aria-label={content.balance}><CurrencyAmount currency="coins" amount={camp.wallet.coins}/><CurrencyAmount currency="diamonds" amount={camp.wallet.diamonds}/></section>}{onSettings&&<button className="secondary" onClick={onSettings} aria-label={content.settings}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg></button>}</div>
    </header>
    {camp&&onCamp&&<aside ref={tasks} className={`spatial-checkins ${checkinsOpen?'is-expanded':''}`} aria-label={content.checkins}>
      <button className="secondary" aria-label={checkinsOpen?content.hideCheckins:content.showCheckins} aria-expanded={checkinsOpen} onClick={()=>setCheckinsOpen(value=>!value)}><svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="m3 6 2 2 3-4m3 2h10M3 13l2 2 3-4m3 2h10M3 20l2 2 3-4m3 2h10" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg><span>{content.checkins}</span></button>
      {checkinsOpen&&<div className="spatial-task-list">{camp.tasks.map(task=><button className="secondary" key={task.id} aria-label={task.name} title={task.name} onClick={()=>leave('camp')}><TaskIcon name={task.icon_key}/></button>)}{!camp.tasks.length&&<p>{content.noTasks}</p>}</div>}
    </aside>}
    {cameraOpen&&<nav id="spatial-camera-controls" ref={cameraControls} className={`spatial-camera ${editing?'is-editing':''}`} aria-label={content.camera}>
      <div><button className="secondary" aria-label={content.cameraLeft} title={content.cameraLeft} onClick={()=>rotateCamera(-1)}>↶</button><button className="secondary spatial-direction" aria-label={cameraPanOpen?content.hidePanControls:content.showPanControls} aria-expanded={cameraPanOpen} title={content.showPanControls} onClick={()=>setCameraPanOpen(value=>!value)}>{content.directions[direction]}</button><button className="secondary" aria-label={content.cameraRight} title={content.cameraRight} onClick={()=>rotateCamera(1)}>↷</button></div>
      <div><button className="secondary" aria-label={content.zoomOut} title={content.zoomOut} onClick={()=>{camera.current=zoomCamera(camera.current,1/1.2);}}>−</button><button className="secondary" aria-label={content.resetCamera} title={content.resetCamera} onClick={()=>focusSpace(indoor?'indoor':'outdoor')}>⌖</button><button className="secondary" aria-label={content.zoomIn} title={content.zoomIn} onClick={()=>{camera.current=zoomCamera(camera.current,1.2);}}>+</button></div>
      {cameraPanOpen&&<div className="spatial-pan"><button className="secondary" aria-label={content.panLeft} onClick={()=>pan(80,0)}>←</button><button className="secondary" aria-label={content.panUp} onClick={()=>pan(0,80)}>↑</button><button className="secondary" aria-label={content.panDown} onClick={()=>pan(0,-80)}>↓</button><button className="secondary" aria-label={content.panRight} onClick={()=>pan(-80,0)}>→</button></div>}
    </nav>}
    <section className="spatial-feedback" aria-live="polite">
      {!view&&<div className="spatial-notice"><p role={layout.error?'alert':'status'}>{layout.error?errorMessage(layout.error):content.loading}</p>{layout.error!==null&&<button onClick={()=>void layout.readLatest()}>{content.retry}</button>}</div>}
      {campError!==null&&<p role="alert">{errorMessage(campError)}</p>}
      {appearance.loading&&!appearance.snapshot&&<p role="status">{content.appearanceLoading}</p>}
      {appearance.error!==null&&<div><p role="alert">{content.appearanceError}</p><button onClick={()=>void appearance.refresh()}>{content.retry}</button></div>}
      {modelError&&<div><p role="alert">{content.sceneError}</p><button onClick={()=>{setModelError(false);setSceneAttempt(value=>value+1);}}>{content.assetRetry}</button></div>}
      {message&&<p role="status">{message}</p>}
      {editing&&issue&&<p role="alert">{content.invalid[issue]}</p>}
      {view&&layout.error!==null&&<p role="alert">{errorMessage(layout.error)}</p>}
      {layout.conflict&&<div><p role="alert">{content.conflict}</p><button disabled={layout.loading} onClick={()=>void layout.readLatest()}>{content.readLatest}</button></div>}
      {layout.unknownSave&&<div><p role="alert">{content.unknownSave}</p><button disabled={layout.loading} onClick={()=>void layout.readLatest()}>{content.readResult}</button>{layout.canRetryOriginal&&<button disabled={layout.saving} onClick={()=>void layout.retryOriginal()}>{content.retryOriginal}</button>}</div>}
      {layout.review&&<div><p>{content.review}</p><p>{content.latestVersion} {layout.state?.version}</p><p>{content.latestItems}: {layout.state?.placements.map(item=>layout.state?.catalog.find(d=>d.item_key===item.item_key)?.name).join('、')}</p><button onClick={layout.confirmReview}>{content.confirmReview}</button><button className="secondary" onClick={cancel}>{content.useLatest}</button></div>}
    </section>
    {editing&&view&&<SpatialInventory state={view} selected={selection} space={space} expanded={panelOpen} busy={busy} saving={layout.saving} sceneNames={Object.fromEntries(scenes.map(item=>[item.scene_key,item.name]))} saveDisabled={!!issue||layout.conflict||layout.review} panelRef={panel} onToggle={()=>setPanelOpen(value=>!value)} onSpace={focusSpace} onChoose={choose} onMove={nudge} onRotate={rotateItem} onStore={store} onSave={()=>void save()} onCancel={cancel} onEnvironment={layout.setEnvironment}/>}
    <footer ref={dock} className={`spatial-dock ${editing?'is-editing':''}`}>
      {!editing&&<div className="spatial-activities" aria-label={content.activitiesTitle}>{(Object.keys(content.activities) as SpatialActorActivity[]).map(key=><button className={`secondary ${key!=='walk'&&key!=='rest'&&!allowed.includes(key)?'is-locked':''}`} key={key} onClick={()=>activity(key)}>{content.activities[key]}</button>)}</div>}
      <div className="spatial-toolbar">{!editing&&<button onClick={begin} disabled={!view||layout.loading}>{content.edit}</button>}<button className="secondary" aria-pressed={indoor} disabled={!view?.scene.house} onClick={()=>focusSpace(indoor?'outdoor':'indoor',true)}>{indoor?content.outdoor:content.indoor}</button>{!editing&&<button className="secondary" disabled={!view?.scene.house} onClick={()=>{setIntent(current=>({sequence:(current?.sequence??0)+1,activity:'walk',space:actor.space==='indoor'?'outdoor':'indoor'}));}}>{actor.space==='indoor'?content.exit:content.enter}</button>}{onShop&&<button className="secondary" disabled={layout.saving} onClick={()=>leave('shop')}>{content.shop}</button>}{!editing&&<button className="secondary" aria-pressed={paused} onClick={()=>setPaused(value=>!value)}>{paused?content.resume:content.pause}</button>}</div>
      {!editing&&<p className={`spatial-actor-status ${stopped?'is-static':''}`} role="status">{stopped?(paused?content.paused:content.static):`${content.activities[actor.activity]} · ${content.phases[actor.phase]}`}</p>}
      {!editing&&access.pending&&<p>{content.accessPending}</p>}{!editing&&access.error!==null&&<div className="spatial-access-error"><span>{content.accessError}</span><button className="secondary" onClick={access.refresh}>{content.retry}</button></div>}
    </footer>
    {scenePickerOpen&&<ScenePicker scenes={scenes} current={sceneKey} loading={scenesLoading} error={scenesError} onChoose={key=>{const target=scenes.find(item=>item.scene_key===key);if(!target||(!target.owned&&!target.free))return;sceneInteracted.current=true;setScenePickerOpen(false);leave({sceneKey:key});}} {...(onShop?{onPurchase:()=>{setScenePickerOpen(false);leave({shopGroup:'scene'});}}:{})} onRetry={()=>setScenesAttempt(value=>value+1)} onClose={()=>setScenePickerOpen(false)}/>}
    {locked&&<Modal title={content.lockedTitle} onClose={()=>setLocked(null)}><p>{content.lockedHint}</p><ul>{access.access?.activity_access.find(item=>item.activity===locked)?.tasks.map(task=><li key={task.id}>{task.name}{!task.enabled?` · ${content.inactiveTask}`:''}</li>)}</ul><div className="button-row">{onCamp&&<button onClick={()=>{setLocked(null);leave('camp');}}>{content.goCamp}</button>}<button className="secondary" onClick={()=>setLocked(null)}>{content.close}</button></div></Modal>}
    {leaving&&<Modal title={content.leaveTitle} onClose={()=>setLeaving(null)} closeDisabled={layout.saving}><p>{layout.unknownSave?content.unknownSave:!editing?content.saved:content.leaveHint}</p><div className="button-row">{!editing&&!layout.unknownSave?<button onClick={()=>{const destination=leaving;setLeaving(null);navigate(destination);}}>{content.continueLeave}</button>:layout.unknownSave?<button disabled={layout.loading} onClick={()=>void layout.readLatest()}>{content.readResult}</button>:<><button disabled={layout.saving||!!issue||layout.conflict||layout.review} onClick={()=>void save(leaving)}>{content.saveLeave}</button><button className="secondary" disabled={layout.saving} onClick={discardLeave}>{content.discardLeave}</button></>}<button className="secondary" disabled={layout.saving} onClick={()=>setLeaving(null)}>{content.stay}</button></div></Modal>}
  </main>;
}
