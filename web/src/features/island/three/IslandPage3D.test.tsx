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

beforeEach(()=>vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}})));
afterEach(()=>vi.unstubAllGlobals());
const renderedScene=vi.hoisted(()=>({current:null as unknown as SpatialScene3DProps}));
vi.mock('./SpatialScene3D',()=>({SpatialScene3D:(props:SpatialScene3DProps)=>{renderedScene.current=props;return <div data-testid="scene-layout">{props.layout.environment_key}</div>;}}));
const initial={version:1,scene_key:configuration.scene.scene_key,environment_key:'day',scene:configuration.scene,catalog:configuration.catalog,placements:configuration.default_placements,inventory:configuration.default_placements.map((p)=>({instance_id:p.instance_id,item_key:p.item_key}))} as SpatialIslandState;

// 组件边界使用真实草稿hook、请求错误及HTML离开流程，Canvas另由真实浏览器验证。
function setup(failure?:ApiFailure){
  let state=structuredClone(initial);
  state.inventory.push({instance_id:'owned-chair-1',item_key:'camp-dining-chair-v1'},{instance_id:'owned-chair-2',item_key:'camp-dining-chair-v1'});
  const request=vi.fn(async(path:string,options?:RequestOptions)=>{
    if(path==='/camp')return structuredClone(camp);
    if(path==='/island/activity-access')return {today:'2026-11-01',expires_at:new Date(Date.now()+3_600_000).toISOString(),activity_access:[{activity:'read',available:false,tasks:[{id:'read-task',name:'今日阅读',enabled:true}]}]};
    if(path==='/island/layout'){
      if(options?.method==='PUT'){
        if(failure)throw failure;
        state={...state,...(options.body as object),version:state.version+1};
      }
      return structuredClone(state);
    }
    throw new Error(path);
  });
  const onBack=vi.fn(),onShop=vi.fn(),onCamp=vi.fn();
  const client={request:request as never};
  const result=render(<IslandPage3D client={client} session={{...testSession,timezone:'Asia/Taipei'}} onBack={onBack} onShop={onShop} onCamp={onCamp}/>);
  return {...result,client,request,onBack,onShop,onCamp,setLatest:(next:SpatialIslandState)=>{state=next;}};
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
    expect(test.onShop).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button',{name:content.saveLeave}));
    await waitFor(()=>expect(test.onShop).toHaveBeenCalledOnce());
    expect(test.request.mock.calls.find(call=>call[1]?.method==='PUT')?.[1]?.body).toMatchObject({expected_version:1,placements:expect.arrayContaining([expect.objectContaining({instance_id:'base:reading3d',x_cm:deskStart.x_cm+10})])});
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
