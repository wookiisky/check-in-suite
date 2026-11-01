import { Bone, Mesh, Skeleton, SkinnedMesh } from 'three';
import type { AnimationAction, AnimationClip, Object3D } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createAnimatedModel } from '../../graphics/animated-model';
import { characterResources } from '../../graphics/gltf-resources';
import type { GLTFSource, GltfResourceCache } from '../../graphics/gltf-resources';
import type { ResolvedAppearance } from './character3d-appearance';

// 准备好的实例独占骨骼和播放器，通过 dispose 归还其使用的共享源资源。
export interface PreparedCharacter {
  key: string; // 当前完整外观的资源身份。
  root: Object3D; // 可放入任意营地或预览 Canvas 的根节点。
  play: (action: string, immediate?: boolean) => void; // 使用目录中的语义动作。
  advance: (seconds: number, paused: boolean) => void; // 逐帧推进，不触发 React 状态更新。
  resetDelta: () => void; // 隐藏或恢复后丢弃第一帧时间差。
  dispose: () => void; // 释放实例与资源引用。
}

// 兼容资源只重新绑定到同名实例骨骼，不改变离线确定的绑定姿势。
function attachWearables(root: Object3D, source: GLTFSource, visibleNames: Set<string>) {
  const bones = new Map<string, Bone>();
  root.traverse((node) => { if (node instanceof Bone) bones.set(node.name, node); });
  const part = clone(source.scene);
  part.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.visible = visibleNames.has(node.name);
    if (!(node instanceof SkinnedMesh) || !node.visible) return;
    const targetBones = node.skeleton.bones.map((bone) => {
      const target = bones.get(bone.name);
      if (!target) throw new Error(`CHARACTER_BONE_MISSING: ${bone.name}`);
      return target;
    });
    node.bind(new Skeleton(targetBones, node.skeleton.boneInverses.map((matrix) => matrix.clone())), node.bindMatrix.clone());
  });
  // 服装由主实例骨骼驱动，移除其来源副本的骨骼以避免动画名称歧义。
  const boneRoots: Bone[] = [];
  part.traverse((node) => { if (node instanceof Bone && !(node.parent instanceof Bone)) boneRoots.push(node); });
  for (const bone of boneRoots) bone.removeFromParent();
  root.add(part);
}

// 先取得全部资源并验证节点，再返回完整实例；错误不会交付半套人物。
export async function prepareCharacter(resolved: ResolvedAppearance, cache: GltfResourceCache = characterResources): Promise<PreparedCharacter> {
  const { definition, wearables } = resolved;
  const urls = [...new Set([definition.model_url, ...wearables.map((item) => item.model_url), ...Object.values(definition.animations).map((item) => item.url)])];
  const leases = urls.map((url) => cache.acquire(url));
  let instance: ReturnType<typeof createAnimatedModel> | undefined;
  try {
    const loaded = await Promise.all(leases.map((lease) => lease.ready));
    const sources = new Map(urls.map((url, index) => [url, loaded[index]!]));
    const base = sources.get(definition.model_url)!;
    instance = createAnimatedModel(base.scene);
    const animated = instance;
    const { root, mixer } = animated;
    root.scale.setScalar(definition.scale);
    const covered = new Set(wearables.flatMap((item) => item.covers));
    const baseNames = new Set([...definition.fixed_nodes, ...Object.entries(definition.body_regions).filter(([region]) => !covered.has(region)).flatMap(([, names]) => names)]);
    for (const wearable of wearables) {
      const source = sources.get(wearable.model_url)!;
      for (const name of wearable.nodes) if (!(source.scene.getObjectByName(name) instanceof SkinnedMesh)) throw new Error(`CHARACTER_MESH_MISSING: ${name}`);
      if (wearable.model_url === definition.model_url) for (const name of wearable.nodes) baseNames.add(name);
    }
    for (const name of baseNames) if (!(root.getObjectByName(name) instanceof Mesh)) throw new Error(`CHARACTER_BODY_MISSING: ${name}`);
    root.traverse((node) => { if (node instanceof Mesh) node.visible = baseNames.has(node.name); });
    for (const url of new Set(wearables.map((item) => item.model_url))) {
      if (url === definition.model_url) continue;
      attachWearables(root, sources.get(url)!, new Set(wearables.filter((item) => item.model_url === url).flatMap((item) => item.nodes)));
    }
    root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = node.visible; node.receiveShadow = node.visible; } });
    const clips = new Map<string, AnimationClip>();
    for (const [semantic, animation] of Object.entries(definition.animations)) {
      const clip = sources.get(animation.url)!.animations.find((candidate) => candidate.name === animation.clip);
      if (!clip) throw new Error(`CHARACTER_ANIMATION_MISSING: ${semantic}`);
      clips.set(semantic, clip);
    }
    let current: AnimationAction | undefined; let skipFrame = true; let disposed = false;
    const prepared: PreparedCharacter = {
      key: resolved.key,
      root,
      play(action, immediate = false) {
        const clip = clips.get(action);
        if (!clip) throw new Error(`CHARACTER_ACTION_MISSING: ${action}`);
        const next = mixer.clipAction(clip);
        if (current === next) return;
        next.reset();
        if (immediate) { mixer.stopAllAction(); next.setEffectiveWeight(1); }
        else if (current) { current.fadeOut(0.15); next.fadeIn(0.15); }
        next.play(); mixer.update(0); current = next;
      },
      advance(seconds, paused) {
        if (paused) { skipFrame = true; return; }
        if (skipFrame) { skipFrame = false; return; }
        mixer.update(Math.min(seconds, 0.05));
      },
      resetDelta() { skipFrame = true; },
      dispose() {
        if (disposed) return;
        disposed = true; animated.dispose(); for (const lease of leases) lease.release();
      },
    };
    prepared.play('idle', true);
    return prepared;
  } catch (error) {
    instance?.dispose(); for (const lease of leases) lease.release(); throw error;
  }
}
