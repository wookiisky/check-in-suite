import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import catalog from '../../../../internal/character/character-catalog.json';
import type { AppearanceState } from './character3d-appearance';
import type { GLTFSource } from '../../graphics/gltf-resources';

// Node测试只替换浏览器图片解码，实际GLB节点、材质、骨架和动作仍由正式加载器解析。
export async function runtimeCharacterSource(url:string):Promise<GLTFSource> {
  const key=new URL(url,'http://runtime-test').pathname.split('/').at(-1)!;
  const path=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../internal/assets/builtin',`${key}.glb`);
  const bytes=await readFile(path);
  const loader=new GLTFLoader();
  loader.register(()=>({name:'TEST_IMAGE_DECODE',loadTexture:()=>Promise.resolve(new Texture())}));
  const source=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  return {scene:source.scene,animations:source.animations};
}

// 库存是本测试的选择夹具；正式购买、图片解码和GPU显示另由真实浏览器验证。
export function runtimeCharacterAppearance():AppearanceState {
  const sets: Record<string, Record<string, { clip: string; asset_key: string }>> = catalog.animation_sets;
  const characters = catalog.characters.map((body) => {
    const bindings = Object.entries(sets[body.rig_key] ?? {});
    const animations = Object.fromEntries(bindings.map(([key, clip]) => [key, { ...clip, url: `/api/v1/assets/${clip.asset_key}` }]));
    return { ...structuredClone(body), animations };
  });
  return {version:1,character_key:catalog.characters[0]!.character_key,default_character_key:catalog.characters[0]!.character_key,
    face_wearable_key:null,back_wearable_key:null,head_wearable_key:null,upper_wearable_key:null,lower_wearable_key:null,shoes_wearable_key:null,
    characters,wearables:structuredClone(catalog.wearables),inventory:[] } as AppearanceState;
}
