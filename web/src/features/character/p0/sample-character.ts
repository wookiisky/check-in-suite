import { Mesh, SkinnedMesh } from 'three';
import type { AnimationAction, AnimationClip, Object3D } from 'three';
import { createAnimatedModel } from '../../../graphics/animated-model';

// 这里只核实原始人物与动作；源部件不符合四槽契约，不能用于正式换装。
export function createSampleCharacter(source: Object3D, animations: AnimationClip[]) {
  const instance = createAnimatedModel(source);
  instance.root.scale.setScalar(1.8 / 2.186978340148926);
  instance.root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.visible = node instanceof SkinnedMesh;
    node.castShadow = node.visible;
    node.receiveShadow = node.visible;
  });
  let current: AnimationAction | undefined;
  return {
    ...instance,
    // 切换动作共用当前实例的播放器，不修改缓存中的 AnimationClip。
    play(name: string) {
      const clip = animations.find((candidate) => candidate.name === name);
      if (!clip) throw new Error(`SAMPLE_ANIMATION_MISSING: ${name}`);
      const next = instance.mixer.clipAction(clip);
      if (next === current) return;
      next.reset();
      if (current) { current.fadeOut(0.15); next.fadeIn(0.15); }
      next.play();
      // 无渲染推进时也先显示动作首帧，避免减少动效退回绑定姿势。
      instance.mixer.update(0);
      current = next;
    },
  };
}
