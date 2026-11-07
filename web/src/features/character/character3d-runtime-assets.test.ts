// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Mesh, SkinnedMesh } from 'three';
import { GltfResourceCache } from '../../graphics/gltf-resources';
import { draftFromAppearance, resolveAppearance } from './character3d-appearance';
import { prepareCharacter } from './character3d-model';
import { runtimeCharacterAppearance, runtimeCharacterSource } from './character3d-runtime-test-source';

describe('实际交付GLB经正式加载器的人物组装',()=>{
  it('封闭铁靴隐藏底层脚掌，卸鞋后恢复脚部', async () => {
    const snapshot = runtimeCharacterAppearance();
    snapshot.character_inventory = snapshot.characters.map((item) => ({ purchase_id: `body-${item.character_key}`, character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ purchase_id: `item-${item.wearable_key}`, wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const body of snapshot.characters) {
      snapshot.character_key = body.character_key;
      for (const key of ['kaykit-skeletons-rogue-shoes', 'shoes-none-v1']) {
        const resolved = resolveAppearance(snapshot, { ...draftFromAppearance(snapshot), shoes_purchase_id: `item-${key}` });
        const instance = await prepareCharacter(resolved, cache);
        try {
          for (const name of body.body_regions.feet!) {
            const meshes: Mesh[] = [];
            instance.root.getObjectByName(name)!.traverse((node) => { if (node instanceof Mesh) meshes.push(node); });
            expect(meshes.length).toBeGreaterThan(0);
            expect(meshes.every((mesh) => mesh.visible === (key === 'shoes-none-v1')), `${body.character_key}/${key}/${name}`).toBe(true);
          }
        } finally { instance.dispose(); }
      }
    }
    expect(cache.size).toBe(0);
  }, 30_000);

  it('眉毛胡须和围领在两种身体上保留所选脸型的头皮', async () => {
    const snapshot = runtimeCharacterAppearance();
    snapshot.character_inventory = snapshot.characters.map((item) => ({ purchase_id: `body-${item.character_key}`, character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ purchase_id: `item-${item.wearable_key}`, wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const body of snapshot.characters) {
      snapshot.character_key = body.character_key;
      for (const key of ['hair-barbarian-v1', 'kaykit-legacy-skeleton-mage-head']) {
        const resolved = resolveAppearance(snapshot, { ...draftFromAppearance(snapshot), head_purchase_id: `item-${key}` });
        const face = resolved.wearables.find((item) => item.slot === 'face')!;
        const instance = await prepareCharacter(resolved, cache);
        try {
          expect(face.nodes).toContain('face_scalp');
          for (const name of face.regions?.scalp ?? ['face_scalp']) {
            const visible = instance.root.getObjectsByProperty('name', name).some((node) => {
              const meshes: Mesh[] = [];
              node.traverse((child) => { if (child instanceof Mesh) meshes.push(child); });
              return meshes.length > 0 && meshes.every((mesh) => mesh.visible);
            });
            expect(visible, `${body.character_key}/${key}/${name}应保留头皮`).toBe(true);
          }
        } finally { instance.dispose(); }
        expect(cache.size).toBe(0);
      }
    }
  }, 30_000);

  it('全部正式人物保留多材质节点的可见网格并播放实际待机',async()=>{
    const snapshot=runtimeCharacterAppearance();
    const cache=new GltfResourceCache(runtimeCharacterSource);
    for(const definition of snapshot.characters) {
      snapshot.character_key=definition.character_key;
      const resolved=resolveAppearance(snapshot);
      const instance=await prepareCharacter(resolved,cache).catch(error=>{throw new Error(`${definition.character_key}: ${String(error)}`);});
      try {
        for(const name of [...definition.fixed_nodes,...resolved.wearables.flatMap(item=>item.nodes)]) {
          const matches=instance.root.getObjectsByProperty('name',name).map(node=>{
            const meshes:Mesh[]=[];node.traverse(child=>{if(child instanceof Mesh)meshes.push(child);});return meshes;
          });
          expect(matches.some(meshes=>meshes.length>0&&meshes.every(mesh=>mesh.visible)),`${definition.character_key}/${name}所选实例的各材质均应显示`).toBe(true);
        }
        instance.advance(0,false);instance.advance(0.05,false);
      } finally {instance.dispose();}
      expect(cache.size).toBe(0);
    }
  },30_000);

  it('每件独立商品均可在两个基础身体上重新绑定并播放动作', async () => {
    const snapshot = runtimeCharacterAppearance();
    expect(snapshot.characters.map((item) => item.character_key)).toEqual(['kaykit-medium-v1', 'kaykit-skeleton-v1']);
    expect(snapshot.characters.every((item) => item.provider !== 'kenney')).toBe(true);
    snapshot.character_inventory = snapshot.characters.map((item) => ({ purchase_id: `body-${item.character_key}`, character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ purchase_id: `item-${item.wearable_key}`, wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const definition of snapshot.characters) {
      snapshot.character_key = definition.character_key;
      for (const wearable of snapshot.wearables) {
        const draft = { ...draftFromAppearance(snapshot), [`${wearable.slot}_purchase_id`]: `item-${wearable.wearable_key}` };
        const resolved = resolveAppearance(snapshot, draft);
        const instance = await prepareCharacter(resolved, cache).catch((error) => { throw new Error(`${definition.character_key}/${wearable.wearable_key}: ${String(error)}`); });
        try {
          const bones = new Map<string, unknown>();
          instance.root.traverse((node) => { if (node.type === 'Bone') bones.set(node.name, node); });
          const visible: SkinnedMesh[] = [];
          instance.root.traverse((node) => { if (node instanceof SkinnedMesh && node.visible) visible.push(node); });
          expect(visible.length).toBeGreaterThan(0);
          for (const mesh of visible) for (const bone of mesh.skeleton.bones) expect(bones.get(bone.name)).toBe(bone);
          instance.advance(0, false); instance.advance(0.05, false);
        } finally { instance.dispose(); }
        expect(cache.size).toBe(0);
      }
    }
  }, 60_000);
});
