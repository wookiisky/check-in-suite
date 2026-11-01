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
  return {version:1,character_key:catalog.characters[0]!.character_key,default_character_key:catalog.characters[0]!.character_key,
    hair_purchase_id:null,upper_purchase_id:null,lower_purchase_id:null,shoes_purchase_id:null,
    characters:structuredClone(catalog.characters),wearables:structuredClone(catalog.wearables),inventory:[] } as AppearanceState;
}
