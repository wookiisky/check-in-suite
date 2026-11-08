import { describe, expect, it, vi } from 'vitest';
import { Matrix4, Mesh, MeshBasicMaterial, SkinnedMesh, Vector3 } from 'three';
import { GltfResourceCache } from '../../graphics/gltf-resources';
import { activityBookSource, appearanceFixture, characterSource, characterWithBookBone, deferred } from './character3d-test-fixtures';
import { draftFromAppearance, resolveAppearance } from './character3d-appearance';
import { prepareCharacter } from './character3d-model';
import type { GLTFSource } from '../../graphics/gltf-resources';

describe('正式人物组装与动画', () => {
  it('所有视图使用独立骨架，未选择部件隐藏并能恢复身体覆盖', async () => {
    const snapshot = appearanceFixture(); const source = characterSource();
    const dispose = vi.spyOn((source.scene.getObjectByName('face') as SkinnedMesh).geometry, 'dispose');
    const cache = new GltfResourceCache(async () => source);
    const first = await prepareCharacter(resolveAppearance(snapshot), cache);
    const second = await prepareCharacter(resolveAppearance(snapshot, { character_key: 'body', face_wearable_key: null, back_wearable_key: null, head_wearable_key: null, upper_wearable_key: 'upper-b', lower_wearable_key: null, shoes_wearable_key: null }), cache);
    expect(first.root.getObjectByName('body')!.visible).toBe(false);
    expect(second.root.getObjectByName('body')!.visible).toBe(true);
    expect(first.root.getObjectByName('upper-b')!.visible).toBe(false);
    expect(second.root.getObjectByName('upper-b')!.visible).toBe(true);
    const firstBody = first.root.getObjectByName('face') as SkinnedMesh; const secondBody = second.root.getObjectByName('face') as SkinnedMesh;
    expect(firstBody.skeleton.bones[0]).not.toBe(secondBody.skeleton.bones[0]);
    first.dispose(); expect(dispose).not.toHaveBeenCalled(); second.dispose(); expect(dispose).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
  });

  it('头饰只遮住所选形象的头皮，卸下后恢复原脸和裸头皮', async () => {
    const snapshot = appearanceFixture();
    const face = snapshot.wearables.find((item) => item.wearable_key === 'face-a')!;
    Object.assign(face, { nodes: ['face-a', 'scalp-a'], regions: { scalp: ['scalp-a'] }, covers: ['head', 'scalp'] });
    snapshot.wearables.find((item) => item.wearable_key === 'head-a')!.covers = ['scalp'];
    Object.assign(snapshot.wearables.find((item) => item.wearable_key === 'head-b')!, { empty: true, nodes: [], covers: [] });
    const source = characterSource();
    const scalp = (source.scene.getObjectByName('face-a') as SkinnedMesh).clone(); scalp.name = 'scalp-a'; source.scene.add(scalp);
    const cache = new GltfResourceCache(async () => source);
    const dressed = await prepareCharacter(resolveAppearance(snapshot), cache);
    const bare = await prepareCharacter(resolveAppearance(snapshot, { ...draftFromAppearance(snapshot), head_wearable_key: 'head-b' }), cache);
    expect(dressed.root.getObjectByName('face-a')!.visible).toBe(true);
    expect(dressed.root.getObjectByName('scalp-a')!.visible).toBe(false);
    expect(bare.root.getObjectByName('face-a')!.visible).toBe(true);
    expect(bare.root.getObjectByName('scalp-a')!.visible).toBe(true);
    expect(bare.root.getObjectByName('head-a')!.visible).toBe(false);
    dressed.dispose(); bare.dispose(); expect(cache.size).toBe(0);
  });

  it('不同资源的服装重绑到身体实例的同一组骨骼', async () => {
    const snapshot = appearanceFixture(); snapshot.upper_wearable_key = 'upper-b';
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

  it.each(['/base.glb', '/shirt.glb'])('配色只修改 %s 中选定衣物的实例材质', async (url) => {
    const snapshot = appearanceFixture();
    const garment = snapshot.wearables.find((item) => item.wearable_key === 'upper-a')!;
    Object.assign(garment, { model_url: url, dye_material: 'fabric', default_color_key: 'ivory' });
    snapshot.wearable_colors = [{ key: 'blue', name: '蓝', hex: '#4179BE' }];
    const body = characterSource();
    const shirt = url === '/base.glb' ? body : characterSource(['upper-a']);
    const mesh = shirt.scene.getObjectByName('upper-a') as SkinnedMesh;
    const fabric = mesh.material as MeshBasicMaterial;
    fabric.name = 'fabric'; fabric.color.set('#F2E8D5');
    const trim = new MeshBasicMaterial({ name: 'trim', color: '#26262A' });
    mesh.material = [fabric, trim];
    const disposeFabric = vi.spyOn(fabric, 'dispose');
    const cache = new GltfResourceCache(async (path) => path === '/base.glb' ? body : shirt);
    const original = await prepareCharacter(resolveAppearance(snapshot), cache);
    const changed = await prepareCharacter(resolveAppearance({ ...snapshot, upper_color_key: 'blue' }), cache);
    const clothingMesh = (model: typeof original) => model.root.getObjectsByProperty('name', 'upper-a').find((node) => node.visible) as SkinnedMesh;
    const changedMesh = clothingMesh(changed);
    const [dyed, retained] = changedMesh.material as MeshBasicMaterial[];
    const disposeDye = vi.spyOn(dyed!, 'dispose');
    expect(changed.key).not.toBe(original.key);
    expect(changedMesh.geometry).toBe(mesh.geometry);
    expect(dyed).not.toBe(fabric);
    expect(dyed!.color.getHexString()).toBe('4179be');
    expect(retained).toBe(trim);
    const originalMaterials = clothingMesh(original).material as MeshBasicMaterial[];
    expect(originalMaterials[0]).toBe(fabric);
    expect(originalMaterials[1]).toBe(trim);
    if (body === shirt) expect((changed.root.getObjectByName('face') as SkinnedMesh).material).toBe(fabric);
    expect(fabric.color.getHexString()).toBe('f2e8d5');
    changed.dispose(); changed.dispose();
    expect(disposeDye).toHaveBeenCalledOnce();
    expect(disposeFabric).not.toHaveBeenCalled();
    original.dispose();
    expect(disposeFabric).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it('换色后发生准备错误也释放实例材质和源资源引用', async () => {
    const snapshot = appearanceFixture();
    Object.assign(snapshot.wearables.find((item) => item.wearable_key === 'upper-a')!, { dye_material: 'fabric', default_color_key: 'ivory' });
    snapshot.wearable_colors = [{ key: 'blue', name: '蓝', hex: '#4179BE' }];
    snapshot.upper_color_key = 'blue';
    const body = characterSource();
    const source = (body.scene.getObjectByName('upper-a') as SkinnedMesh).material as MeshBasicMaterial;
    source.name = 'fabric';
    const copy = source.clone();
    vi.spyOn(source, 'clone').mockReturnValue(copy);
    const disposeCopy = vi.spyOn(copy, 'dispose');
    const cache = new GltfResourceCache(async () => body);
    const attachment = { model_url: '/base.glb', bone: 'absent', matrix: new Matrix4().elements };
    await expect(prepareCharacter(resolveAppearance(snapshot, undefined, [attachment]), cache)).rejects.toThrow('CHARACTER_ATTACHMENT_BONE_MISSING');
    expect(disposeCopy).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
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

  it('按外部活动时间直接采样，跨周期后仍与道具同步', async () => {
    const cache = new GltfResourceCache(async () => characterSource());
    const instance = await prepareCharacter(resolveAppearance(appearanceFixture()), cache);
    const bone = instance.root.getObjectByName('root')!;
    instance.seek(0.625);
    expect(bone.position.y).toBeCloseTo(0.825);
    instance.seek(2.625);
    expect(bone.position.y).toBeCloseTo(0.825);
    instance.seek(3);
    expect(bone.position.y).toBeCloseTo(0.2);
    instance.dispose();
  });

  it('部件或动作资源无效时释放已取得的全部引用', async () => {
    const resolved = resolveAppearance(appearanceFixture()); resolved.wearables[0]!.nodes = ['absent'];
    const cache = new GltfResourceCache(async () => characterSource());
    await expect(prepareCharacter(resolved, cache)).rejects.toThrow(); expect(cache.size).toBe(0);
  });

  it('活动书按完整矩阵挂接实例骨骼，卸载不会影响另一个人物或共享资源', async () => {
    const body = characterWithBookBone(); const book = activityBookSource();
    const bookGeometry = (book.scene.getObjectByName('activity-book') as Mesh).geometry;
    const disposeBook = vi.spyOn(bookGeometry, 'dispose');
    const matrix = new Matrix4().makeRotationY(Math.PI / 3).setPosition(0.1, 0.2, 0.3);
    const attachment = { model_url: '/book.glb', bone: 'handslotl', matrix: matrix.elements };
    const resolved = resolveAppearance(appearanceFixture(), undefined, [attachment]);
    const cache = new GltfResourceCache(async (url) => url === '/book.glb' ? book : body);
    const first = await prepareCharacter(resolved, cache); const second = await prepareCharacter(resolved, cache);
    const hand = first.root.getObjectByName('handslotl')!; const wrapper = hand.children[0]!;
    expect(wrapper).not.toBe(second.root.getObjectByName('handslotl')!.children[0]);
    expect(wrapper.matrix.equals(matrix)).toBe(true);
    first.root.updateMatrixWorld(true);
    const expected = hand.matrixWorld.clone().multiply(matrix);
    expect(wrapper.getWorldPosition(new Vector3()).distanceTo(new Vector3().setFromMatrixPosition(expected))).toBeLessThan(1e-10);
    expect((first.root.getObjectByName('activity-book') as Mesh).geometry).toBe(bookGeometry);
    first.dispose(); expect(wrapper.parent).toBeNull(); expect(disposeBook).not.toHaveBeenCalled();
    expect(second.root.getObjectByName('activity-book')).toBeDefined();
    second.dispose(); expect(disposeBook).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
    expect(book.scene.getObjectByName('activity-book')!.parent).toBe(book.scene);
  });

  it('书本未就绪时不交付无书人物，完成后释放取消结果的资源', async () => {
    const pending = deferred<GLTFSource>(); const book = activityBookSource();
    const cache = new GltfResourceCache((url) => url === '/book.glb' ? pending.promise : Promise.resolve(characterWithBookBone()));
    const attachment = { model_url: '/book.glb', bone: 'handslotl', matrix: new Matrix4().elements };
    let finished = false;
    const preparation = prepareCharacter(resolveAppearance(appearanceFixture(), undefined, [attachment]), cache).then((value) => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
    pending.resolve(book); const instance = await preparation;
    expect(instance.root.getObjectByName('activity-book')).toBeDefined(); instance.dispose(); expect(cache.size).toBe(0);
  });

  it('挂点缺失或矩阵损坏返回准备错误，并归还全部资源引用', async () => {
    const cache = new GltfResourceCache(async (url) => url === '/book.glb' ? activityBookSource() : characterWithBookBone());
    for (const attachment of [
      { model_url: '/book.glb', bone: 'not-a-bone', matrix: new Matrix4().elements },
      { model_url: '/book.glb', bone: 'handslotl', matrix: [1, 2] },
      { model_url: '/book.glb', bone: 'handslotl', matrix: new Array<number>(16).fill(0) },
      { model_url: '/book.glb', bone: 'handslotl', matrix: new Matrix4().elements.map((value, index) => index === 0 ? Number.NaN : value) },
    ]) {
      await expect(prepareCharacter(resolveAppearance(appearanceFixture(), undefined, [attachment]), cache)).rejects.toThrow();
      expect(cache.size).toBe(0);
    }
  });

  it('书本仍在下载时取消准备，立即归还引用并回收迟到的静态资源', async () => {
    const pending = deferred<GLTFSource>(); const body = characterWithBookBone(); const book = activityBookSource();
    const bodyDispose = vi.spyOn((body.scene.getObjectByName('face') as Mesh).geometry, 'dispose');
    const bookDispose = vi.spyOn((book.scene.getObjectByName('activity-book') as Mesh).geometry, 'dispose');
    const cache = new GltfResourceCache((url) => url === '/book.glb' ? pending.promise : Promise.resolve(body));
    const controller = new AbortController();
    const attachment = { model_url: '/book.glb', bone: 'handslotl', matrix: new Matrix4().elements };
    const preparation = prepareCharacter(resolveAppearance(appearanceFixture(), undefined, [attachment]), cache, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.size).toBe(0); expect(bodyDispose).toHaveBeenCalledTimes(1);
    pending.resolve(book); await pending.promise; await Promise.resolve(); await Promise.resolve();
    expect(bookDispose).toHaveBeenCalledTimes(1);
  });
});
