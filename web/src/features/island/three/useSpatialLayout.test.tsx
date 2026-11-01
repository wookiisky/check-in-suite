import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../../api/client';
import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialIslandState } from './spatial-ui-types';
import { useSpatialLayout } from './useSpatialLayout';

const initial={version:1,scene_key:configuration.scene.scene_key,environment_key:'day',scene:configuration.scene,catalog:configuration.catalog,placements:configuration.default_placements,inventory:configuration.default_placements.map((p)=>({instance_id:p.instance_id,item_key:p.item_key}))} as SpatialIslandState;
function setup(failure?:ApiFailure){
  let latest=structuredClone(initial);
  const request=vi.fn(async(_path:string, options?:{method?:string;body?:unknown})=>{
    if(options?.method==='PUT') { if(failure)throw failure; const body=options.body as {placements:SpatialIslandState['placements'];environment_key:string}; latest={...latest,version:latest.version+1,...body}; }
    return structuredClone(latest);
  });
  const client={request:request as never};
  return {...renderHook(()=>useSpatialLayout(client)),request,setLatest:(value:SpatialIslandState)=>{latest=value;}};
}
describe('3D布局草稿保存',()=>{
  it('取消还原环境与位置；成功保存采用真实版本后退出编辑',async()=>{
    const test=setup(); await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>{test.result.current.begin();});
    act(()=>test.result.current.setEnvironment('dusk'));
    expect(test.result.current.dirty).toBe(true);
    act(()=>test.result.current.cancel());
    expect(test.result.current.view?.environment_key).toBe('day');
    act(()=>test.result.current.begin()); act(()=>test.result.current.setEnvironment('dusk'));
    let saved=false; await act(async()=>{saved=await test.result.current.save();});
    expect(saved).toBe(true); expect(test.result.current.state?.version).toBe(2); expect(test.result.current.editing).toBe(false);
    expect(test.request.mock.calls.at(-1)?.[1]?.body).toMatchObject({expected_version:1,environment_key:'dusk'});
  });
  it('版本冲突保留草稿，读取最新后必须核对再允许保存',async()=>{
    const test=setup(new ApiFailure(409,{code:'VERSION_CONFLICT',field_errors:{},request_id:''}));
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin()); act(()=>test.result.current.setEnvironment('dusk'));
    await act(async()=>{expect(await test.result.current.save()).toBe(false);});
    expect(test.result.current.conflict).toBe(true); expect(test.result.current.view?.environment_key).toBe('dusk');
    test.setLatest({...initial,version:2}); await act(async()=>{await test.result.current.readLatest();});
    expect(test.result.current.review).toBe(true); expect(test.result.current.view?.environment_key).toBe('dusk');
    await act(async()=>{expect(await test.result.current.save()).toBe(false);});
    expect(test.request.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(1);
    act(()=>test.result.current.confirmReview()); expect(test.result.current.review).toBe(false);
  });
  it('网络失败不报告成功，结果未知时重读实际布局以恢复',async()=>{
    const test=setup(new ApiFailure(0,{code:'NETWORK_ERROR',field_errors:{},request_id:''}));
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin()); act(()=>test.result.current.setEnvironment('dusk'));
    await act(async()=>{expect(await test.result.current.save()).toBe(false);});
    expect(test.result.current.unknownSave).toBe(true); expect(test.result.current.editing).toBe(true);
    test.setLatest({...initial,version:2,environment_key:'dusk'});
    await act(async()=>{await test.result.current.readLatest();});
    expect(test.result.current.editing).toBe(false); expect(test.result.current.unknownSave).toBe(false); expect(test.result.current.state?.version).toBe(2);
  });
});

// 可控请求让读取和保存能按实际竞态顺序完成。
function deferred<T>() {
  let resolve!: (value:T)=>void;
  let reject!: (reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

const networkFailure=()=>new ApiFailure(0,{code:'NETWORK_ERROR',field_errors:{},request_id:''});

describe('独立场景草稿',()=>{
  it('读回其他场景不能成为当前保存基线',async()=>{
    const client={request:vi.fn().mockResolvedValue(structuredClone(initial)) as never};
    const test=renderHook(()=>useSpatialLayout(client,'forest-courtyard-v1'));
    await waitFor(()=>expect(test.result.current.loading).toBe(false));
    expect(test.result.current.state).toBeNull();
    expect(test.result.current.error).toBeInstanceOf(ApiFailure);
    expect(test.result.current.editing).toBe(false);
  });
  it('同一客户端切换场景时隔离草稿、版本与读取目标',async()=>{
    const request=vi.fn(async(path:string)=>structuredClone(path.includes('forest-courtyard-v1')?{...initial,scene_key:'forest-courtyard-v1',scene:{...initial.scene,scene_key:'forest-courtyard-v1'},version:7}:initial));
    const client={request:request as never};
    const test=renderHook(({scene})=>useSpatialLayout(client,scene),{initialProps:{scene:'seaside-v1'}});
    await waitFor(()=>expect(test.result.current.state?.scene_key).toBe('seaside-v1'));
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    test.rerender({scene:'forest-courtyard-v1'});
    await waitFor(()=>expect(test.result.current.state?.version).toBe(7));
    expect(test.result.current.editing).toBe(false);
    expect(request).toHaveBeenCalledWith('/island/layout?scene_key=forest-courtyard-v1',expect.anything());
    test.rerender({scene:'seaside-v1'});
    await waitFor(()=>expect(test.result.current.loading).toBe(false));
    expect(test.result.current.view?.environment_key).toBe('dusk');
    expect(test.result.current.review).toBe(true);
  });

  it('保存结果未知后切换并返回，只核对原场景并保留原请求',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string;body?:unknown})=>{
      if(options?.method==='PUT')throw networkFailure();
      return structuredClone(path.includes('forest-courtyard-v1')?{...initial,scene_key:'forest-courtyard-v1',scene:{...initial.scene,scene_key:'forest-courtyard-v1'},version:9}:initial);
    });
    const client={request:request as never};
    const test=renderHook(({scene})=>useSpatialLayout(client,scene),{initialProps:{scene:'seaside-v1'}});
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    await act(async()=>{await test.result.current.save();});
    test.rerender({scene:'forest-courtyard-v1'});
    await waitFor(()=>expect(test.result.current.state?.scene_key).toBe('forest-courtyard-v1'));
    expect(test.result.current.unknownSave).toBe(false);
    test.rerender({scene:'seaside-v1'});
    await waitFor(()=>expect(test.result.current.canRetryOriginal).toBe(true));
    expect(test.result.current.unknownSave).toBe(true);
    await act(async()=>{await test.result.current.retryOriginal();});
    const bodies=request.mock.calls.filter(call=>call[1]?.method==='PUT').map(call=>call[1]?.body);
    expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({scene_key:'seaside-v1',expected_version:1});
  });
});

describe('3D布局未知结果与读取竞争',()=>{
  it('未推进的读回保留原请求，禁止修改或取消，并只能显式重发原版本',async()=>{
    let writes=0;
    const request=vi.fn(async(_path:string,options?:{method?:string;body?:unknown})=>{
      if(options?.method==='PUT'){
        if(++writes===1)throw networkFailure();
        return {...initial,version:2,environment_key:'dusk'};
      }
      return structuredClone(initial);
    });
    const client={request:request as never};
    const test=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    await act(async()=>{await test.result.current.save();});
    act(()=>test.result.current.setEnvironment('day'));
    act(()=>test.result.current.setPlacements([]));
    act(()=>{expect(test.result.current.cancel()).toBe(false);});
    expect(test.result.current.view?.environment_key).toBe('dusk');
    expect(test.result.current.view?.placements).toEqual(initial.placements);
    expect(test.result.current.canLeave).toBe(false);
    await act(async()=>{expect(await test.result.current.retryOriginal()).toBe(false);});
    await act(async()=>{await test.result.current.readLatest();});
    expect(test.result.current.unknownSave).toBe(true);
    expect(test.result.current.canRetryOriginal).toBe(true);
    act(()=>test.result.current.confirmReview());
    await act(async()=>{expect(await test.result.current.save()).toBe(false);});
    await act(async()=>{expect(await test.result.current.retryOriginal()).toBe(true);});
    const bodies=request.mock.calls.filter(call=>call[1]?.method==='PUT').map(call=>call[1]?.body);
    expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({expected_version:1,environment_key:'dusk'});
  });

  it('即使布局值相同，读回版本没有推进也不能确认保存',async()=>{
    const test=setup(networkFailure());
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());
    await act(async()=>{await test.result.current.save();await test.result.current.readLatest();});
    expect(test.result.current.unknownSave).toBe(true);expect(test.result.current.editing).toBe(true);
  });

  it('读回已经推进但值不同时要求核对，确认后才使用新版本',async()=>{
    const test=setup(networkFailure());
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    await act(async()=>{await test.result.current.save();});
    test.setLatest({...initial,version:3});
    await act(async()=>{await test.result.current.readLatest();});
    expect(test.result.current.review).toBe(true);expect(test.result.current.unknownSave).toBe(false);
    expect(test.result.current.view?.environment_key).toBe('dusk');
    await act(async()=>{expect(await test.result.current.retryOriginal()).toBe(false);});
    act(()=>test.result.current.confirmReview());
    await act(async()=>{await test.result.current.save();});
    expect(test.request.mock.calls.at(-1)?.[1]?.body).toMatchObject({expected_version:3});
  });

  it('同客户端卸载重挂后恢复未知请求与草稿',async()=>{
    const request=vi.fn(async(_path:string,options?:{method?:string})=>{if(options?.method==='PUT')throw networkFailure();return structuredClone(initial);});
    const client={request:request as never};
    const first=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(first.result.current.state).not.toBeNull());
    act(()=>first.result.current.begin());act(()=>first.result.current.setEnvironment('dusk'));
    await act(async()=>{await first.result.current.save();});first.unmount();
    const second=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(second.result.current.loading).toBe(false));
    expect(second.result.current.unknownSave).toBe(true);expect(second.result.current.view?.environment_key).toBe('dusk');
    expect(second.result.current.canLeave).toBe(false);expect(second.result.current.canRetryOriginal).toBe(true);
  });

  it('卸载后才失败的保存仍保留原请求，客户端切换不会串入新页面',async()=>{
    const write=deferred<SpatialIslandState>();
    const requestA=vi.fn((_path:string,options?:{method?:string})=>options?.method==='PUT'?write.promise:Promise.resolve(structuredClone(initial)));
    const clientA={request:requestA as never};
    const clientB={request:vi.fn().mockResolvedValue({...initial,version:8}) as never};
    const test=renderHook(({client})=>useSpatialLayout(client),{initialProps:{client:clientA}});
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    let saving!:Promise<boolean>;act(()=>{saving=test.result.current.save();});
    test.rerender({client:clientB});await waitFor(()=>expect(test.result.current.state?.version).toBe(8));
    await act(async()=>{write.reject(networkFailure());await saving;});
    expect(test.result.current.state?.version).toBe(8);expect(test.result.current.unknownSave).toBe(false);
    test.rerender({client:clientA});await waitFor(()=>expect(test.result.current.loading).toBe(false));
    expect(test.result.current.unknownSave).toBe(true);expect(test.result.current.view?.environment_key).toBe('dusk');
  });

  it('新读取取消旧读取并拒绝迟到结果，状态变化不重建view',async()=>{
    const old=deferred<SpatialIslandState>();const latest=deferred<SpatialIslandState>();
    const request=vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const client={request:request as never};const test=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    const view=test.result.current.view;
    let first!:Promise<unknown>;let second!:Promise<unknown>;
    act(()=>{first=test.result.current.readLatest();});expect(test.result.current.view).toBe(view);
    act(()=>{second=test.result.current.readLatest();});
    expect(request.mock.calls[1]?.[1]?.signal.aborted).toBe(true);
    await act(async()=>{latest.resolve({...initial,version:4});await second;});
    await act(async()=>{old.resolve({...initial,version:2});await first;});
    expect(test.result.current.state?.version).toBe(4);
  });
});

describe('3D布局跨挂载请求隔离',()=>{
  it('切换客户端取消旧GET，切回后迟到旧响应也不能覆盖新GET',async()=>{
    const old=deferred<SpatialIslandState>();
    const requestA=vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({...initial,version:4});
    const clientA={request:requestA as never};
    const clientB={request:vi.fn().mockResolvedValue({...initial,version:8}) as never};
    const test=renderHook(({client})=>useSpatialLayout(client),{initialProps:{client:clientA}});
    test.rerender({client:clientB});
    await waitFor(()=>expect(test.result.current.state?.version).toBe(8));
    expect(requestA.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    test.rerender({client:clientA});
    await waitFor(()=>expect(test.result.current.state?.version).toBe(4));
    await act(async()=>{old.resolve({...initial,version:2});});
    expect(test.result.current.state?.version).toBe(4);
  });

  it('保存中卸载重挂不会重发，真实成功后恢复已保存快照',async()=>{
    const write=deferred<SpatialIslandState>();
    const request=vi.fn((_path:string,options?:{method?:string})=>options?.method==='PUT'?write.promise:Promise.resolve(initial));
    const client={request:request as never};
    const first=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(first.result.current.state).not.toBeNull());
    act(()=>first.result.current.begin());act(()=>first.result.current.setEnvironment('dusk'));
    let saving!:Promise<boolean>;act(()=>{saving=first.result.current.save();});first.unmount();
    const second=renderHook(()=>useSpatialLayout(client));
    expect(second.result.current.saving).toBe(true);expect(second.result.current.canLeave).toBe(false);
    await act(async()=>{write.resolve({...initial,version:2,environment_key:'dusk'});expect(await saving).toBe(true);});
    expect(second.result.current.state?.version).toBe(2);expect(second.result.current.editing).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('保存使在途读取失效，晚到的旧GET不能回退已保存布局',async()=>{
    const read=deferred<SpatialIslandState>();
    const request=vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(read.promise).mockResolvedValueOnce({...initial,version:2,environment_key:'dusk'});
    const client={request:request as never};const test=renderHook(()=>useSpatialLayout(client));
    await waitFor(()=>expect(test.result.current.state).not.toBeNull());
    act(()=>test.result.current.begin());act(()=>test.result.current.setEnvironment('dusk'));
    let reading!:Promise<unknown>;act(()=>{reading=test.result.current.readLatest();});
    await act(async()=>{expect(await test.result.current.save()).toBe(true);});
    expect(request.mock.calls[1]?.[1]?.signal.aborted).toBe(true);
    await act(async()=>{read.resolve(initial);await reading;});
    expect(test.result.current.state?.version).toBe(2);expect(test.result.current.view?.environment_key).toBe('dusk');
  });
});
