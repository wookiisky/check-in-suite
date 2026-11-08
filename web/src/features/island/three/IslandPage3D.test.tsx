import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from '../../../api/client';
import { ApiFailure } from '../../../api/client';
import { testSession } from '../../../test/account-fixtures';
import { camp } from '../../shop/test-fixtures';
import configuration from '../../../../../internal/island/spatial-scene.json';
import { IslandPage3D } from '../IslandPage3D';
import type { SpatialScene3DProps } from './SpatialScene3D';
import type { SpatialIslandState } from './spatial-ui-types';
import content from './spatial-content.json';
import scenesContent from './scene-picker-content.json';

beforeEach(()=>{localStorage.clear();vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));});
afterEach(()=>vi.unstubAllGlobals());
const renderedScene=vi.hoisted(()=>({current:null as unknown as SpatialScene3DProps}));
vi.mock('./SpatialScene3D',()=>({SpatialScene3D:(props:SpatialScene3DProps)=>{renderedScene.current=props;return <div data-testid="scene-layout">{props.layout.environment_key}</div>;}}));
const initial={version:1,scene_key:configuration.scene.scene_key,environment_key:'day',scene:configuration.scene,catalog:configuration.catalog,placements:configuration.default_placements,inventory:configuration.default_placements.map((p)=>({instance_id:p.instance_id,item_key:p.item_key}))} as SpatialIslandState;

// 组件边界使用真实草稿hook、请求错误及HTML离开流程，Canvas另由真实浏览器验证。
function setup(failure?:ApiFailure,prepare?:(state:SpatialIslandState)=>void,initialSceneKey?:string){
  let state=structuredClone(initial);
  state.inventory.push({instance_id:'owned-chair-1',item_key:'camp-dining-chair-v1'},{instance_id:'owned-chair-2',item_key:'camp-dining-chair-v1'});
  prepare?.(state);
  const request=vi.fn(async(path:string,options?:RequestOptions)=>{
    if(path==='/camp')return structuredClone(camp);
    if(path==='/island/activity-access')return {today:'2026-11-01',expires_at:new Date(Date.now()+3_600_000).toISOString(),activity_access:[{activity:'read',available:false,tasks:[{id:'read-task',name:'今日阅读',enabled:true}]}]};
    if(path==='/island/scenes')return {items:[{scene_key:'seaside-v1',name:'海边营地',thumbnail_url:'/sea.png',free:true,owned:true},{scene_key:'forest-courtyard-v1',name:'林间草地庭院',thumbnail_url:'/forest.png',free:false,owned:true},{scene_key:'lakeside-garden-v1',name:'湖畔花园',thumbnail_url:'/lake.png',free:false,owned:false}]};
    if(path==='/island/layout?scene_key=forest-courtyard-v1')return {...structuredClone(state),version:4,scene_key:'forest-courtyard-v1',scene:{...structuredClone(state.scene),scene_key:'forest-courtyard-v1',house:null},placements:[]};
    if(path==='/island/layout'){
      if(options?.method==='PUT'){
        if(failure)throw failure;
        state={...state,...(options.body as object),version:state.version+1};
      }
      return structuredClone(state);
    }
    throw new Error(path);
  });
  const onBack=vi.fn(),onShop=vi.fn(),onCamp=vi.fn(),onNavigate=vi.fn();
  const client={request:request as never};
  const result=render(<IslandPage3D client={client} session={{...testSession,timezone:'Asia/Taipei'}} {...(initialSceneKey?{initialSceneKey}:{})} onBack={onBack} onShop={onShop} onCamp={onCamp} onNavigate={onNavigate}/>);
  return {...result,client,request,onBack,onShop,onCamp,onNavigate,setLatest:(next:SpatialIslandState)=>{state=next;}};
}
const deskStart=initial.placements.find(item=>item.instance_id==='base:reading3d')!;
const movedPosition=`${content.position} ${deskStart.x_cm+10}, ${deskStart.z_cm}`;
async function editDesk(){
  await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:content.edit}));
  const name=configuration.catalog.find(item=>item.item_key==='camp-reading-desk-v1')!.name;
  fireEvent.click(screen.getByRole('button',{name:content.select.replace('{name}',name)}));
  fireEvent.click(screen.getByRole('button',{name:content.moveRight}));
}

describe('三维营地页面业务交互',()=>{
  it('跨场景占用失败显示原因，读取最新库存后保留并可修正草稿',async()=>{
    const test=setup(new ApiFailure(400,{code:'INVALID_REQUEST',field_errors:{placements:'PLACED_IN_OTHER_SCENE'},request_id:'occupancy-conflict'}));
    await editDesk();
    const chairName=configuration.catalog.find(item=>item.item_key==='camp-dining-chair-v1')!.name;
    const deskName=configuration.catalog.find(item=>item.item_key==='camp-reading-desk-v1')!.name;
    fireEvent.click(screen.getByRole('button',{name:content.add.replace('{name}',chairName)}));
    fireEvent.click(screen.getByRole('button',{name:content.select.replace('{name}',deskName)}));
    fireEvent.click(screen.getByRole('button',{name:content.save}));
    await screen.findByText(content.inventoryConflict);
    expect(screen.queryByText(content.conflict)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.save})).toBeDisabled();
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    test.setLatest({...structuredClone(initial),inventory:[...initial.inventory,{instance_id:'owned-chair-1',item_key:'camp-dining-chair-v1',placed_scene_key:'forest-courtyard-v1'},{instance_id:'owned-chair-2',item_key:'camp-dining-chair-v1'}]});
    fireEvent.click(screen.getByRole('button',{name:content.readInventory}));
    await screen.findByText(content.review);
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    expect(renderedScene.current.layout.version).toBe(1);
    expect(renderedScene.current.layout.placements.some(item=>item.instance_id==='owned-chair-1')).toBe(true);
    expect(test.request.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(1);
    const conflictedChair=screen.getByRole('button',{name:content.select.replace('{name}',chairName)});
    expect(conflictedChair).toBeEnabled();
    fireEvent.click(conflictedChair);
    const beforeMove=renderedScene.current.layout.placements.find(item=>item.instance_id==='owned-chair-1')!;
    act(()=>renderedScene.current.onPlacement({...beforeMove,x_cm:beforeMove.x_cm+10}));
    expect(renderedScene.current.layout.placements.find(item=>item.instance_id==='owned-chair-1')).toEqual(beforeMove);
    expect(screen.getByRole('button',{name:content.moveRight})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:content.store}));
    fireEvent.click(screen.getByRole('button',{name:content.confirmReview}));
    expect(renderedScene.current.layout.placements.some(item=>item.instance_id==='owned-chair-1')).toBe(false);
    expect(renderedScene.current.layout.placements.find(item=>item.instance_id==='base:reading3d')?.x_cm).toBe(deskStart.x_cm+10);
    expect(screen.getByRole('button',{name:content.save})).toBeEnabled();
  });

  it('收起主屋后可收起剩余室内家具，修正草稿后再保存',async()=>{
    const chair={instance_id:'owned-chair-1',item_key:'camp-dining-chair-v1',space:'indoor' as const,x_cm:150,z_cm:0,rotation:0};
    setup(undefined,state=>state.placements.push(chair));await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:content.edit}));
    const houseName=configuration.catalog.find(item=>item.assembly==='house')!.name;
    fireEvent.click(screen.getByRole('button',{name:content.select.replace('{name}',houseName)}));
    fireEvent.click(screen.getByRole('button',{name:content.store}));
    expect(screen.getByText(content.invalid.house)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:content.indoorItems}));
    const indoors=[...initial.placements.filter(item=>item.space==='indoor'),chair];
    for(const placement of indoors){
      const name=configuration.catalog.find(item=>item.item_key===placement.item_key)!.name;
      fireEvent.click(screen.getByRole('button',{name:content.select.replace('{name}',name)}));
      fireEvent.click(screen.getByRole('button',{name:content.store}));
    }
    expect(screen.queryByText(content.invalid.house)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.save})).toBeEnabled();
    expect(renderedScene.current.indoor).toBe(false);
  });
  it('恢复设备选择前核对场景资格，未拥有的旧选择不会发起布局请求',async()=>{
    localStorage.setItem(scenesContent.storageKey,'lakeside-garden-v1');
    const test=setup();
    await waitFor(()=>expect(test.request).toHaveBeenCalledWith('/island/scenes',expect.anything()));
    await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    expect(test.request.mock.calls.some(call=>call[0].includes('scene_key='))).toBe(false);
    expect(renderedScene.current.layout.scene_key).toBe('seaside-v1');
  });

  it('明确前往海边时更新设备偏好，不沿用旧的其他场景目的地',async()=>{
    localStorage.setItem(scenesContent.storageKey,'forest-courtyard-v1');
    const test=setup(undefined,undefined,'seaside-v1');
    await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    expect(renderedScene.current.layout.scene_key).toBe('seaside-v1');
    expect(localStorage.getItem(scenesContent.storageKey)).toBe('seaside-v1');
    expect(test.request.mock.calls.some(call=>call[0].includes('scene_key='))).toBe(false);
  });

  it('明确导航目标也先核对资格，未拥有时不能读取目标布局',async()=>{
    localStorage.setItem(scenesContent.storageKey,'forest-courtyard-v1');
    const test=setup(undefined,undefined,'lakeside-garden-v1');
    await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    expect(renderedScene.current.layout.scene_key).toBe('seaside-v1');
    expect(test.request.mock.calls.some(call=>call[0].includes('scene_key='))).toBe(false);
  });

  it('本次明确目的地只在首次进入使用，后续props变化不重放导航',async()=>{
    const test=setup(undefined,undefined,'forest-courtyard-v1');
    await waitFor(()=>expect(renderedScene.current.layout.scene_key).toBe('forest-courtyard-v1'));
    const calls=test.request.mock.calls.length;
    test.rerender(<IslandPage3D client={test.client} session={{...testSession,timezone:'Asia/Taipei'}} initialSceneKey="seaside-v1" />);
    expect(renderedScene.current.layout.scene_key).toBe('forest-courtyard-v1');
    expect(test.request.mock.calls).toHaveLength(calls);
  });

  it('已解锁的设备选择在重新进入时恢复，不修改服务端家庭当前场景',async()=>{
    localStorage.setItem(scenesContent.storageKey,'forest-courtyard-v1');
    const test=setup();
    await waitFor(()=>expect(renderedScene.current.layout.scene_key).toBe('forest-courtyard-v1'));
    expect(test.request.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(0);
  });

  it('换成较小主屋保留家具草稿并明确显示冲突，不自动清空室内',async()=>{
    setup(undefined,state=>{
      const original=state.scene.house!;
      const current=state.catalog.find(item=>item.assembly==='house')!;
      state.catalog.push({...current,item_key:'tiny-house',name:'试验小屋',house_key:'tiny-house'});
      state.houses={'tiny-house':{...original,interior:{min_x_cm:-80,max_x_cm:80,min_z_cm:-80,max_z_cm:80}}};
      state.inventory.push({instance_id:'tiny-house-owned',item_key:'tiny-house'});
    });
    await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:content.edit}));
    fireEvent.click(screen.getByRole('button',{name:content.add.replace('{name}','试验小屋')}));
    expect(renderedScene.current.layout.placements.filter(item=>renderedScene.current.layout.catalog.find(definition=>definition.item_key===item.item_key)?.assembly==='house')).toHaveLength(1);
    expect(renderedScene.current.layout.placements.some(item=>item.instance_id==='tiny-house-owned')).toBe(true);
    expect(renderedScene.current.layout.placements.filter(item=>item.space==='indoor')).toEqual(initial.placements.filter(item=>item.space==='indoor'));
    expect(screen.getByText(content.invalid.boundary)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.save})).toBeDisabled();
  });
  it('前往已解锁场景时独立读取并记住本设备选择，无房场景不提供室内入口',async()=>{
    const test=setup();await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:scenesContent.open}));
    fireEvent.click(await screen.findByRole('button',{name:scenesContent.go.replace('{name}','林间草地庭院')}));
    await waitFor(()=>expect(renderedScene.current.layout.scene_key).toBe('forest-courtyard-v1'));
    expect(localStorage.getItem(scenesContent.storageKey)).toBe('forest-courtyard-v1');
    expect(screen.getByRole('button',{name:content.indoor})).toBeDisabled();
    expect(screen.getByRole('button',{name:content.enter})).toBeDisabled();
    expect(test.request.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(0);
  });

  it('切场景复用草稿离开流程，继续编辑不切换，放弃后才进入目标',async()=>{
    const test=setup();await editDesk();
    fireEvent.click(screen.getByRole('button',{name:scenesContent.open}));
    fireEvent.click(await screen.findByRole('button',{name:scenesContent.go.replace('{name}','林间草地庭院')}));
    let dialog=screen.getByRole('dialog',{name:content.leaveTitle});
    fireEvent.click(within(dialog).getByRole('button',{name:content.stay}));
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    expect(test.request.mock.calls.some(call=>call[0].includes('scene_key=forest'))).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:scenesContent.open}));
    fireEvent.click(screen.getByRole('button',{name:scenesContent.go.replace('{name}','林间草地庭院')}));
    dialog=screen.getByRole('dialog',{name:content.leaveTitle});
    fireEvent.click(within(dialog).getByRole('button',{name:content.discardLeave}));
    await waitFor(()=>expect(renderedScene.current.layout.scene_key).toBe('forest-courtyard-v1'));
  });

  it('切场景保存失败时保留原场景和草稿，不读取目标或更新设备选择',async()=>{
    const test=setup(new ApiFailure(0,{code:'NETWORK_ERROR',field_errors:{},request_id:''}));await editDesk();
    fireEvent.click(screen.getByRole('button',{name:scenesContent.open}));
    fireEvent.click(await screen.findByRole('button',{name:scenesContent.go.replace('{name}','林间草地庭院')}));
    fireEvent.click(within(screen.getByRole('dialog',{name:content.leaveTitle})).getByRole('button',{name:content.saveLeave}));
    await waitFor(()=>expect(within(screen.getByRole('dialog')).getByText(content.unknownSave)).toBeInTheDocument());
    expect(renderedScene.current.layout.scene_key).toBe('seaside-v1');
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    expect(test.request.mock.calls.some(call=>call[0].includes('scene_key=forest'))).toBe(false);
    expect(localStorage.getItem(scenesContent.storageKey)).not.toBe('forest-courtyard-v1');
  });

  it('未解锁场景进入商店，不请求该场景布局',async()=>{
    const test=setup();await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:scenesContent.open}));
    fireEvent.click(await screen.findByRole('button',{name:scenesContent.buy.replace('{name}','湖畔花园')}));
    expect(test.onShop).toHaveBeenCalledOnce();
    expect(test.request.mock.calls.some(call=>call[0].includes('lakeside'))).toBe(false);
  });
  it('无修改离开清除干净草稿，同客户端重进保持浏览状态',async()=>{
    const test=setup();await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:content.edit}));
    fireEvent.click(screen.getByRole('button',{name:content.back}));
    expect(test.onBack).toHaveBeenCalledOnce();test.unmount();
    render(<IslandPage3D client={test.client} session={{...testSession,timezone:'Asia/Taipei'}}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    expect(screen.queryByRole('complementary',{name:content.inventory})).not.toBeInTheDocument();
    expect(screen.queryByText(content.review)).not.toBeInTheDocument();
  });

  it('室内过门只自动取景一次，后续状态更新不拉回用户镜头',async()=>{
    setup();await waitFor(()=>expect(renderedScene.current.layout).toBeTruthy());
    const before={...renderedScene.current.camera.current};
    act(()=>renderedScene.current.onStatus({phase:'walking',activity:'walk',space:'indoor'}));
    expect(renderedScene.current.camera.current.zoom).toBe(2.8);
    renderedScene.current.camera.current.x=9;
    act(()=>renderedScene.current.onStatus({phase:'performing',activity:'rest',space:'indoor'}));
    expect(renderedScene.current.camera.current.x).toBe(9);
    act(()=>renderedScene.current.onStatus({phase:'walking',activity:'walk',space:'outdoor'}));
    expect(renderedScene.current.camera.current).toEqual(before);
  });
  it('完整库存按独立实例摆放和收起，重复物品能区分',async()=>{
    setup();await waitFor(()=>expect(screen.getByRole('button',{name:content.edit})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:content.edit}));
    fireEvent.click(screen.getByRole('button',{name:content.indoorItems}));
    const chair=configuration.catalog.find(item=>item.item_key==='camp-dining-chair-v1')!.name;
    expect(screen.getByRole('button',{name:content.add.replace('{name}',content.additionalInstance.replace('{name}',chair).replace('{number}','2'))})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:content.add.replace('{name}',chair)}));
    expect(renderedScene.current.layout.placements.some(item=>item.instance_id==='owned-chair-1')).toBe(true);
    fireEvent.click(within(screen.getByRole('region',{name:chair})).getByRole('button',{name:content.store}));
    expect(renderedScene.current.layout.placements.some(item=>item.instance_id==='owned-chair-1')).toBe(false);
  });

  it('取消布置恢复原值，不调用PUT；完整库存分区保留保存和取消',async()=>{
    const test=setup();await editDesk();
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:content.cancel}));
    expect(screen.queryByRole('complementary',{name:content.inventory})).not.toBeInTheDocument();
    expect(test.request.mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:content.edit}));
    fireEvent.click(screen.getByRole('button',{name:content.indoorItems}));
    expect(screen.getByRole('button',{name:content.save})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.cancel})).toBeInTheDocument();
    expect(within(screen.getByRole('complementary',{name:content.inventory})).getByRole('button',{name:content.select.replace('{name}',configuration.catalog.find(d=>d.item_key==='camp-reading-desk-v1')!.name)})).toBeInTheDocument();
  });
  it('返回和商店先询问未保存布局，只有保存成功后导航',async()=>{
    const test=setup();await editDesk();
    fireEvent.click(screen.getByRole('button',{name:content.shop}));
    const dialog=screen.getByRole('dialog',{name:content.leaveTitle});
    expect(test.onNavigate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button',{name:content.saveLeave}));
    await waitFor(()=>expect(test.onNavigate).toHaveBeenCalledWith('shop'));
    expect(test.request.mock.calls.find(call=>call[1]?.method==='PUT')?.[1]?.body).toMatchObject({expected_version:1,placements:expect.arrayContaining([expect.objectContaining({instance_id:'base:reading3d',x_cm:deskStart.x_cm+10})])});
  });
  it('标题栏离开营地也必须确认未保存的布置', async () => {
    const test = setup();
    await editDesk();
    const nav = screen.getByRole('navigation', { name: '主要导航' });
    fireEvent.click(within(nav).getByRole('button', { name: '装扮' }));
    const dialog = screen.getByRole('dialog', { name: content.leaveTitle });
    expect(test.onNavigate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: content.discardLeave }));
    expect(test.onNavigate).toHaveBeenCalledWith('appearance');
  });
  it('保存失败保留草稿且不离开，未知结果不能放弃后误当取消',async()=>{
    const test=setup(new ApiFailure(0,{code:'NETWORK_ERROR',field_errors:{},request_id:''}));await editDesk();
    fireEvent.click(screen.getByRole('button',{name:content.back}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:content.saveLeave}));
    await waitFor(()=>expect(within(screen.getByRole('dialog')).getByText(content.unknownSave)).toBeInTheDocument());
    expect(test.onBack).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:content.discardLeave})).not.toBeInTheDocument();
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
  });
  it('离开时占用冲突在弹窗内提供库存读取，失败不能导航',async()=>{
    const test=setup(new ApiFailure(400,{code:'INVALID_REQUEST',field_errors:{placements:'PLACED_IN_OTHER_SCENE'},request_id:'occupancy-conflict'}));
    await editDesk();
    fireEvent.click(screen.getByRole('button',{name:content.back}));
    const dialog=screen.getByRole('dialog',{name:content.leaveTitle});
    fireEvent.click(within(dialog).getByRole('button',{name:content.saveLeave}));
    await within(dialog).findByText(content.inventoryConflict);
    expect(within(dialog).getByRole('button',{name:content.readInventory})).toBeEnabled();
    expect(within(dialog).getByRole('button',{name:content.saveLeave})).toBeDisabled();
    expect(test.onBack).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button',{name:content.readInventory}));
    await screen.findByText(content.review);
    expect(test.onBack).not.toHaveBeenCalled();
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
  });
  it('409后读取最新保留草稿，明确核对前禁用保存',async()=>{
    const test=setup(new ApiFailure(409,{code:'VERSION_CONFLICT',field_errors:{},request_id:''}));await editDesk();
    fireEvent.click(screen.getByRole('button',{name:content.save}));
    await screen.findByText(content.conflict);
    test.setLatest({...initial,version:2,placements:initial.placements.map(p=>p.instance_id==='base:reading3d'?{...p,x_cm:-800}:p)});
    fireEvent.click(screen.getByRole('button',{name:content.readLatest}));
    await screen.findByText(content.review);
    expect(screen.getByText(movedPosition)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.save})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:content.confirmReview}));
    expect(screen.getByRole('button',{name:content.save})).toBeEnabled();
  });
  it('活动锁定说明显示关联任务，通过已有打卡入口进入',async()=>{
    const test=setup();await waitFor(()=>expect(test.request).toHaveBeenCalledWith('/island/activity-access',expect.anything()));
    fireEvent.click(screen.getByRole('button',{name:content.activities.read}));
    const dialog=screen.getByRole('dialog',{name:content.lockedTitle});
    expect(within(dialog).getByText('今日阅读')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button',{name:content.goCamp}));expect(test.onCamp).toHaveBeenCalledOnce();
  });
});
