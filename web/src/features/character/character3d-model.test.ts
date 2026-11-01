import { describe, expect, it, vi } from 'vitest';
import { SkinnedMesh } from 'three';
import { GltfResourceCache } from '../../graphics/gltf-resources';
import { appearanceFixture, characterSource } from './character3d-test-fixtures';
import { resolveAppearance } from './character3d-appearance';
import { prepareCharacter } from './character3d-model';

describe('正式人物组装与动画', () => {
  it('所有视图使用独立骨架，未选择部件隐藏并能恢复身体覆盖', async () => {
    const snapshot = appearanceFixture(); const source = characterSource();
    const dispose = vi.spyOn((source.scene.getObjectByName('face') as SkinnedMesh).geometry, 'dispose');
    const cache = new GltfResourceCache(async () => source);
    const first = await prepareCharacter(resolveAppearance(snapshot), cache);
    const second = await prepareCharacter(resolveAppearance(snapshot, { character_key: 'body', hair_purchase_id: null, upper_purchase_id: 'purchase-upper', lower_purchase_id: null, shoes_purchase_id: null }), cache);
    expect(first.root.getObjectByName('body')!.visible).toBe(false);
    expect(second.root.getObjectByName('body')!.visible).toBe(true);
    expect(first.root.getObjectByName('upper-b')!.visible).toBe(false);
    expect(second.root.getObjectByName('upper-b')!.visible).toBe(true);
    const firstBody = first.root.getObjectByName('face') as SkinnedMesh; const secondBody = second.root.getObjectByName('face') as SkinnedMesh;
    expect(firstBody.skeleton.bones[0]).not.toBe(secondBody.skeleton.bones[0]);
    first.dispose(); expect(dispose).not.toHaveBeenCalled(); second.dispose(); expect(dispose).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
  });

  it('不同资源的服装重绑到身体实例的同一组骨骼', async () => {
    const snapshot = appearanceFixture(); snapshot.upper_purchase_id = 'purchase-upper';
    snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!.model_url = '/shirt.glb';
    const base = characterSource(); const shirt = characterSource(['upper-b']);
    const cache = new GltfResourceCache(async (url) => url === '/shirt.glb' ? shirt : base);
    const instance = await prepareCharacter(resolveAppearance(snapshot), cache);
    const face = instance.root.getObjectByName('face') as SkinnedMesh;
    const selected = instance.root.getObjectsByProperty('name', 'upper-b').find((node) => node.visible) as SkinnedMesh;
    expect(selected.skeleton.bones[0]).toBe(face.skeleton.bones[0]);
    expect(selected.skeleton.bones[0]).not.toBe((shirt.scene.getObjectByName('upper-b') as SkinnedMesh).skeleton.bones[0]);
    instance.dispose(); expect(cache.size).toBe(0);
  });

  it('先显示动作首帧，暂停与恢复不补算时间', async () => {
    const cache = new GltfResourceCache(async () => characterSource());
    const instance = await prepareCharacter(resolveAppearance(appearanceFixture()), cache);
    const bone = instance.root.getObjectByName('root')!;
    expect(bone.position.y).toBeCloseTo(0.2);
    instance.advance(0.01, false); instance.advance(0.05, false);
    expect(bone.position.y).toBeCloseTo(0.25);
    instance.advance(100, true); expect(bone.position.y).toBeCloseTo(0.25);
    instance.advance(100, false); expect(bone.position.y).toBeCloseTo(0.25);
    instance.advance(0.05, false); expect(bone.position.y).toBeCloseTo(0.3);
    instance.dispose();
  });

  it('部件或动作资源无效时释放已取得的全部引用', async () => {
    const resolved = resolveAppearance(appearanceFixture()); resolved.wearables[0]!.nodes = ['absent'];
    const cache = new GltfResourceCache(async () => characterSource());
    await expect(prepareCharacter(resolved, cache)).rejects.toThrow(); expect(cache.size).toBe(0);
  });
});
