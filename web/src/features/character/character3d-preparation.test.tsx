import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { appearanceFixture, deferred, preparedCharacterFixture } from './character3d-test-fixtures';
import { resolveAppearance } from './character3d-appearance';
import type { PreparedCharacter } from './character3d-model';
import { usePreparedCharacter } from './character3d-preparation';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./character3d-model', () => ({ prepareCharacter: prepare }));

describe('人物异步准备', () => {
  it('新结果全部就绪才替换，失败保留上一套，迟到实例立即释放', async () => {
    const pending = Array.from({ length: 4 }, () => deferred<PreparedCharacter>());
    prepare.mockReset(); for (const request of pending) prepare.mockReturnValueOnce(request.promise);
    const resolved = resolveAppearance(appearanceFixture());
    const { result, rerender, unmount } = renderHook(({ key }) => usePreparedCharacter({ resolved: { ...resolved, key } }), { initialProps: { key: 'a' } });
    const a = preparedCharacterFixture('a'); const b = preparedCharacterFixture('b'); const c = preparedCharacterFixture('c');
    const disposeA = vi.spyOn(a, 'dispose'); const disposeB = vi.spyOn(b, 'dispose'); const disposeC = vi.spyOn(c, 'dispose');
    await act(async () => { pending[0]!.resolve(a); });
    expect(result.current.character).toBe(a);
    rerender({ key: 'b' }); expect(result.current.status.phase).toBe('loading'); expect(result.current.character).toBe(a);
    await act(async () => { pending[1]!.reject(new Error('network')); });
    expect(result.current.status.phase).toBe('error'); expect(result.current.character).toBe(a); expect(disposeA).not.toHaveBeenCalled();
    rerender({ key: 'c' }); rerender({ key: 'd' });
    await act(async () => { pending[3]!.resolve(c); });
    expect(result.current.character).toBe(c); expect(disposeA).toHaveBeenCalledTimes(1);
    await act(async () => { pending[2]!.resolve(b); });
    expect(result.current.character).toBe(c); expect(disposeB).toHaveBeenCalledTimes(1);
    unmount(); expect(disposeC).toHaveBeenCalledTimes(1);
  });

  it('卸载取消尚未完成的准备，同一选择可以显式重试', async () => {
    const pending = deferred<PreparedCharacter>(); prepare.mockReset().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(preparedCharacterFixture('retry'));
    const resolved = resolveAppearance(appearanceFixture());
    const first = renderHook(() => usePreparedCharacter({ resolved })); first.unmount();
    const abandoned = preparedCharacterFixture('abandoned'); const dispose = vi.spyOn(abandoned, 'dispose');
    await act(async () => { pending.resolve(abandoned); }); expect(dispose).toHaveBeenCalledTimes(1);
    const { result, rerender } = renderHook(({ attempt }) => usePreparedCharacter({ resolved }, attempt), { initialProps: { attempt: 0 } });
    await waitFor(() => expect(result.current.status.phase).toBe('error'));
    rerender({ attempt: 1 }); await waitFor(() => expect(result.current.status.phase).toBe('ready'));
    expect(result.current.character?.root.name).toBe('retry');
  });
});
