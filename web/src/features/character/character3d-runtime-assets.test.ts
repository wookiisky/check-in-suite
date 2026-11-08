// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial, SkinnedMesh } from 'three';
import type { Object3D } from 'three';
import { GltfResourceCache } from '../../graphics/gltf-resources';
import wearableColors from '../../../../internal/character/wearable-colors.json';
import { draftFromAppearance, resolveAppearance } from './character3d-appearance';
import { prepareCharacter } from './character3d-model';
import { runtimeCharacterAppearance, runtimeCharacterSource } from './character3d-runtime-test-source';

// 正式 GLB 中一个穿戴节点可按材质拆成多张网格。
function visibleMaterials(root: Object3D, names: readonly string[]) {
  const materials = new Set<MeshStandardMaterial>();
  for (const name of names) {
    for (const match of root.getObjectsByProperty('name', name)) {
      match.traverse((node) => {
        if (!(node instanceof Mesh) || !node.visible) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (material instanceof MeshStandardMaterial) materials.add(material);
        }
      });
    }
  }
  return [...materials];
}

describe('实际交付GLB经正式加载器的人物组装',()=>{
  it('紫色三件套共用 GLB 时各槽可独立换色，并保留原色实例与固定装饰', async () => {
    const snapshot = runtimeCharacterAppearance();
    snapshot.wearable_colors = wearableColors;
    const parts = [
      { slot: 'head', key: 'kaykit-adventurers-mage-head', color: 'red' },
      { slot: 'upper', key: 'kaykit-adventurers-mage-upper', color: 'green' },
      { slot: 'lower', key: 'kaykit-adventurers-mage-lower', color: 'yellow' },
    ] as const;
    for (const { slot, key } of parts) {
      snapshot.inventory.push({ wearable_key: key });
      snapshot[`${slot}_wearable_key`] = key;
    }
    const wearables = parts.map(({ key }) => snapshot.wearables.find((item) => item.wearable_key === key)!);
    expect(new Set(wearables.map((item) => item.model_url)).size).toBe(1);
    const cache = new GltfResourceCache(runtimeCharacterSource);
    const original = await prepareCharacter(resolveAppearance(snapshot), cache);
    try {
      const draft = draftFromAppearance(snapshot);
      for (const { slot, color } of parts) draft[`${slot}_color_key`] = color;
      const dyed = await prepareCharacter(resolveAppearance(snapshot, draft), cache);
      try {
        for (const [index, wearable] of wearables.entries()) {
          const paletteColor = wearableColors.find((item) => item.key === parts[index]!.color)!;
          const before = visibleMaterials(original.root, wearable.nodes);
          const after = visibleMaterials(dyed.root, wearable.nodes);
          const tinted = after.filter((material) => material.name === wearable.dye_material);
          expect(tinted.length).toBeGreaterThan(0);
          expect(tinted.map((material) => material.color.getHexString())).toEqual(
            tinted.map(() => paletteColor.hex.slice(1).toLowerCase()),
          );
          const originalDye = before.filter((material) => material.name === wearable.dye_material);
          expect(originalDye.length).toBe(tinted.length);
          expect(originalDye.every((material) => !tinted.includes(material))).toBe(true);
          const accents = before.filter((material) => material.name !== wearable.dye_material);
          expect(accents.length).toBeGreaterThan(0);
          expect(after.filter((material) => material.name !== wearable.dye_material)).toEqual(accents);
        }
      } finally { dyed.dispose(); }
    } finally { original.dispose(); }
    expect(cache.size).toBe(0);
  });

  it('短发可随脸型切换眉须，换色只覆盖当前穿戴的头发与可见附属件', async () => {
    const snapshot = runtimeCharacterAppearance();
    snapshot.wearable_colors = wearableColors;
    const wearable = snapshot.wearables.find((item) => item.wearable_key === 'kaykit-adventurers-ranger-head')!;
    snapshot.inventory = [{ wearable_key: wearable.wearable_key }];
    snapshot.head_wearable_key = wearable.wearable_key;
    snapshot.head_color_key = 'purple';
    const color = wearableColors.find((item) => item.key === 'purple')!.hex.slice(1).toLowerCase();
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const [bodyIndex, shown, hidden] of [
      [0, 'ranger_smile_beard', 'ranger_original_features'],
      [1, 'ranger_original_features', 'ranger_smile_beard'],
    ] as const) {
      snapshot.character_key = snapshot.characters[bodyIndex]!.character_key;
      const instance = await prepareCharacter(resolveAppearance(snapshot), cache);
      try {
        for (const name of ['head_provider', shown]) {
          const materials = visibleMaterials(instance.root, [name]).filter((material) => material.name === wearable.dye_material);
          expect(materials.length, name).toBeGreaterThan(0);
          expect(materials.every((material) => material.color.getHexString() === color), name).toBe(true);
        }
        expect(visibleMaterials(instance.root, [hidden])).toHaveLength(0);
        if (bodyIndex === 0) {
          const faceBrows = visibleMaterials(instance.root, ['face_brows']);
          expect(faceBrows.length).toBeGreaterThan(0);
          expect(faceBrows.every((material) => material.color.getHexString() !== color)).toBe(true);
        }
      } finally { instance.dispose(); }
    }
    expect(cache.size).toBe(0);
  });

  it('封闭铁靴隐藏底层脚掌，卸鞋后恢复脚部', async () => {
    const snapshot = runtimeCharacterAppearance();
    snapshot.character_inventory = snapshot.characters.map((item) => ({ character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const body of snapshot.characters) {
      snapshot.character_key = body.character_key;
      for (const key of ['kaykit-skeletons-rogue-shoes', 'shoes-none-v1']) {
        const resolved = resolveAppearance(snapshot, { ...draftFromAppearance(snapshot), shoes_wearable_key: key });
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
    snapshot.character_inventory = snapshot.characters.map((item) => ({ character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const body of snapshot.characters) {
      snapshot.character_key = body.character_key;
      for (const key of ['hair-barbarian-v1', 'kaykit-legacy-skeleton-mage-head']) {
        const resolved = resolveAppearance(snapshot, { ...draftFromAppearance(snapshot), head_wearable_key: key });
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
    snapshot.character_inventory = snapshot.characters.map((item) => ({ character_key: item.character_key }));
    snapshot.inventory = snapshot.wearables.map((item) => ({ wearable_key: item.wearable_key }));
    const cache = new GltfResourceCache(runtimeCharacterSource);
    for (const definition of snapshot.characters) {
      snapshot.character_key = definition.character_key;
      for (const wearable of snapshot.wearables) {
        const draft = { ...draftFromAppearance(snapshot), [`${wearable.slot}_wearable_key`]: wearable.wearable_key };
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
