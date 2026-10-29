import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedIslandActivities, useIslandActivityAccess } from './useIslandActivityAccess';
import type { IslandAccess } from './useIslandActivityAccess';
import type { IslandState } from './island-types';

// 台北午夜前后的响应只替换资格，布局仍由页面维护。
function snapshot(expires = '2026-10-30T00:00:00+08:00'): IslandState {
  return { version: 9, catalog: [], inventory: [], placements: [], today: '2026-10-29', expires_at: expires,
    activity_access: [
      { activity: 'read', available: true, tasks: [{ id: 'reading', name: '阅读', enabled: true }] },
      { activity: 'run', available: true, tasks: [] },
      { activity: 'ball', available: false, tasks: [{ id: 'exercise', name: '运动', enabled: false }] },
    ] };
}

// 可控响应验证过期和请求乱序，不依赖实际网络时序。
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T23:59:59+08:00')); });
afterEach(() => vi.useRealTimers());

describe('小岛活动资格刷新', () => {
  it('设备快一天时仍按校准时间采用资格并在真实台北午夜刷新', async () => {
    vi.setSystemTime(new Date('2026-10-30T23:59:59+08:00'));
    const response = deferred<IslandState>();
    const request = vi.fn().mockReturnValue(response.promise);
    const client = { request, now: () => new Date(Date.now() - 24 * 60 * 60 * 1000) };
    const initial = snapshot();
    const { result } = renderHook(() => useIslandActivityAccess(client, initial));
    expect(allowedIslandActivities(result.current.access, client.now().getTime())).toEqual(['read', 'run']);
    expect(request).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(request).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(request).toHaveBeenCalledOnce();
    expect(allowedIslandActivities(result.current.access, client.now().getTime())).toEqual(['run']);
    await act(async () => { response.resolve({ ...initial, today: '2026-10-30', expires_at: '2026-10-31T00:00:00+08:00' }); });
    expect(allowedIslandActivities(result.current.access, client.now().getTime())).toEqual(['read', 'run']);
    expect(result.current.error).toBeNull();
  });

  it('过期只保留没有关联任务的自由活动，未知资格不开放活动', () => {
    const access: IslandAccess = snapshot();
    expect(allowedIslandActivities(null)).toEqual([]);
    expect(allowedIslandActivities(access)).toEqual(['read', 'run']);
    vi.advanceTimersByTime(1000);
    expect(allowedIslandActivities(access)).toEqual(['run']);
  });

  it('午夜先失效，昨日迟到响应不能恢复资格，也不无限重试', async () => {
    const response = deferred<IslandState>();
    const request = vi.fn().mockReturnValue(response.promise);
    const initial = snapshot();
    const client = { request };
    const { result } = renderHook(() => useIslandActivityAccess(client, initial));
    expect(allowedIslandActivities(result.current.access)).toEqual(['read', 'run']);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    await act(async () => { response.resolve(initial); });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(initial.placements).toEqual([]);
  });

  it('恢复前台刷新；失败保留失效状态，重试可恢复当前资格', async () => {
    const response = deferred<IslandState>();
    const request = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(snapshot());
    const initial = snapshot();
    const client = { request };
    const { result } = renderHook(() => useIslandActivityAccess(client, initial));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(result.current.pending).toBe(true);
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    await act(async () => { response.reject(new Error('offline')); });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    await act(async () => { result.current.refresh(); });
    expect(result.current.error).toBeNull();
    expect(allowedIslandActivities(result.current.access)).toEqual(['read', 'run']);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('新读取覆盖旧在途响应，卸载后也不再处理响应', async () => {
    const old = deferred<IslandState>();
    const current = deferred<IslandState>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const initial = snapshot();
    const client = { request };
    const { result, unmount } = renderHook(() => useIslandActivityAccess(client, initial));
    await act(async () => { result.current.refresh(); result.current.refresh(); });
    const locked = snapshot();
    locked.activity_access[0]!.available = false;
    await act(async () => { current.resolve(locked); });
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    await act(async () => { old.resolve(initial); });
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
    unmount();
    expect(request.mock.calls[1]?.[1].signal.aborted).toBe(true);
  });

  it('过期保存响应不会重开昨日活动，当前保存响应可更新资格', async () => {
    const request = vi.fn().mockResolvedValue({ ...snapshot('2026-10-31T00:00:00+08:00'), today: '2026-10-30' });
    const initial = snapshot();
    const client = { request };
    const { result, rerender } = renderHook(({ state }) => useIslandActivityAccess(client, state), { initialProps: { state: initial } });
    vi.setSystemTime(new Date('2026-10-30T00:00:01+08:00'));
    await act(async () => { rerender({ state: { ...initial, version: 10 } }); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.access?.today).toBe('2026-10-30');
    expect(result.current.access).not.toHaveProperty('placements');
    const locked = snapshot('2026-10-31T00:00:00+08:00');
    locked.today = '2026-10-30';
    locked.activity_access[0]!.available = false;
    await act(async () => { rerender({ state: locked }); });
    expect(allowedIslandActivities(result.current.access)).toEqual(['run']);
  });
});
