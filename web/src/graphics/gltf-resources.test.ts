import { describe, expect, it, vi } from 'vitest';
import { characterSource, deferred } from '../features/character/character3d-test-fixtures';
import { GltfResourceCache } from './gltf-resources';
import type { GLTFSource } from './gltf-resources';

describe('共享 GLB 生命周期', () => {
  it('并发使用只加载一次，最后一个使用者释放后才销毁共享几何', async () => {
    const source = characterSource(); const geometry = source.scene.getObjectByName('face')!;
    const dispose = vi.spyOn((geometry as import('three').SkinnedMesh).geometry, 'dispose');
    const load = vi.fn(async () => source); const cache = new GltfResourceCache(load);
    const first = cache.acquire('/model'); const second = cache.acquire('/model');
    expect(await first.ready).toBe(await second.ready); expect(load).toHaveBeenCalledTimes(1);
    first.release(); expect(dispose).not.toHaveBeenCalled();
    second.release(); expect(dispose).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
    second.release(); expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('未完成加载被释放时，完成后回收；失败后可重新请求', async () => {
    const result = deferred<GLTFSource>(); const source = characterSource();
    const dispose = vi.spyOn((source.scene.getObjectByName('face')! as import('three').SkinnedMesh).geometry, 'dispose');
    const cache = new GltfResourceCache(() => result.promise);
    const lease = cache.acquire('/pending'); lease.release(); result.resolve(source); await lease.ready;
    expect(dispose).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
    const loader = vi.fn().mockRejectedValueOnce(new Error('load')).mockResolvedValue(source);
    const retryCache = new GltfResourceCache(loader);
    const failed = retryCache.acquire('/retry'); await expect(failed.ready).rejects.toThrow('load'); failed.release();
    const retry = retryCache.acquire('/retry'); await expect(retry.ready).resolves.toBe(source); retry.release();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
