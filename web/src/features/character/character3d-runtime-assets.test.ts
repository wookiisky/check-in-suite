// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Mesh, SkinnedMesh } from 'three';
import { GltfResourceCache } from '../../graphics/gltf-resources';
import { characterSlots, resolveAppearance } from './character3d-appearance';
import { prepareCharacter } from './character3d-model';
import { runtimeCharacterAppearance, runtimeCharacterSource } from './character3d-runtime-test-source';

describe('实际交付GLB经正式加载器的人物组装',()=>{
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

  it('所有人物穿初始四槽与胡须，所有人物的四槽也能绑到默认身体',async()=>{
    const snapshot=runtimeCharacterAppearance(),initial=snapshot.characters[0]!;
    const cache=new GltfResourceCache(runtimeCharacterSource);
    snapshot.inventory.push({purchase_id:'beard',wearable_key:'hair-barbarian-v1'});
    for(const definition of snapshot.characters) {
      const free=Object.fromEntries(characterSlots.map(slot=>[`${slot}_free_wearable_key`,initial.defaults[slot]]));
      const choices=[resolveAppearance(snapshot,{character_key:definition.character_key,hair_purchase_id:null,upper_purchase_id:null,lower_purchase_id:null,shoes_purchase_id:null,...free}),
        resolveAppearance(snapshot,{character_key:definition.character_key,hair_purchase_id:'beard',upper_purchase_id:null,lower_purchase_id:null,shoes_purchase_id:null,...free,hair_free_wearable_key:null})];
      const purchase=`outfit-${definition.character_key}`;
      snapshot.inventory.push(...characterSlots.map(slot=>({purchase_id:purchase,wearable_key:definition.defaults[slot]})));
      choices.push(resolveAppearance(snapshot,{character_key:initial.character_key,hair_purchase_id:purchase,upper_purchase_id:purchase,lower_purchase_id:purchase,shoes_purchase_id:purchase}));
      for(const resolved of choices) {
        const instance=await prepareCharacter(resolved,cache).catch(error=>{throw new Error(`${definition.character_key}混搭: ${String(error)}`);});
        try {
          const bones=new Map<string,unknown>();
          instance.root.traverse(node=>{if(node.type==='Bone')bones.set(node.name,node);});
          const visible:SkinnedMesh[]=[];
          instance.root.traverse(node=>{if(node instanceof SkinnedMesh&&node.visible)visible.push(node);});
          expect(visible.length).toBeGreaterThan(0);
          for(const mesh of visible)for(const bone of mesh.skeleton.bones)expect(bones.get(bone.name)).toBe(bone);
          instance.advance(0,false);instance.advance(0.05,false);
        } finally {instance.dispose();}
      }
      expect(cache.size).toBe(0);
    }
  },30_000);
});
