import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, VectorKeyframeTrack } from 'three';
import type { components } from '../../api/schema';
import type { GLTFSource } from '../../graphics/gltf-resources';

// 测试使用真实 Three 蒙皮对象，网络顺序由独立 deferred 控制。
export function characterSource(names = ['face', 'body', 'hair-a', 'hair-b', 'upper-a', 'upper-b', 'lower-a', 'lower-b', 'shoes-a', 'shoes-b']): GLTFSource {
  const scene = new Group();
  const bone = new Bone(); bone.name = 'root'; scene.add(bone);
  const geometry = new BoxGeometry();
  const count = geometry.attributes.position!.count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4); for (let index = 0; index < count; index++) weights[index * 4] = 1;
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const material = new MeshBasicMaterial(); const skeleton = new Skeleton([bone]);
  for (const name of names) { const mesh = new SkinnedMesh(geometry, material); mesh.name = name; scene.add(mesh); mesh.bind(skeleton); }
  const animation = new AnimationClip('Stand', 1, [new VectorKeyframeTrack('root.position', [0, 1], [0, 0.2, 0, 0, 1.2, 0])]);
  return { scene, animations: [animation] };
}

// 活动挂点保留加载器已经清理后的骨骼名，不在运行时推测另一种命名。
export function characterWithBookBone(): GLTFSource {
  const source = characterSource();
  const hand = new Bone(); hand.name = 'handslotl'; hand.position.set(0.3, 0.4, 0.2);
  source.scene.getObjectByName('root')!.add(hand);
  return source;
}

// 活动书是静态网格，几何和材质由共享资源缓存持有。
export function activityBookSource(): GLTFSource {
  const scene = new Group();
  const book = new Mesh(new BoxGeometry(0.5, 0.05, 0.3), new MeshBasicMaterial()); book.name = 'activity-book';
  scene.add(book); return { scene, animations: [] };
}

// 四槽定义和所有权是服务响应，不依赖商品名称或 key 前缀。
export function appearanceFixture(): components['schemas']['AppearanceState'] {
  const slots = ['hair', 'upper', 'lower', 'shoes'] as const;
  return {
    version: 1, character_key: 'body', hair_purchase_id: null, upper_purchase_id: null, lower_purchase_id: null, shoes_purchase_id: null,
    characters: [{ name: '测试人物', character_key: 'body', rig_key: 'rig', model_asset_key: 'base', model_url: '/base.glb', scale: 1, fixed_nodes: ['face'], body_regions: { torso: ['body'] }, defaults: { hair: 'hair-a', upper: 'upper-a', lower: 'lower-a', shoes: 'shoes-a' }, animations: { idle: { clip: 'Stand', asset_key: 'base', url: '/base.glb' } } }],
    wearables: slots.flatMap((slot) => ['a', 'b'].map((variant) => ({ name: `${slot}/${variant}`, wearable_key: `${slot}-${variant}`, slot, character_key: 'body', rig_key: 'rig', model_asset_key: 'base', model_url: '/base.glb', thumbnail_asset_key: `${slot}-${variant}`, thumbnail_url: '/thumbnail.png', nodes: [`${slot}-${variant}`], covers: slot === 'upper' && variant === 'a' ? ['torso'] : [] }))),
    inventory: slots.map((slot) => ({ purchase_id: `purchase-${slot}`, wearable_key: `${slot}-b` })),
  };
}

// 显式控制异步完成，验证迟到、失败和取消。
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// 异步准备测试只观察实例提交和释放，蒙皮与播放由真实组装测试验证。
export function preparedCharacterFixture(name: string): import('./character3d-model').PreparedCharacter {
  const root = new Group(); root.name = name;
  return { key: name, root, play() {}, advance() {}, resetDelta() {}, dispose() { root.clear(); } };
}
