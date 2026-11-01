import { AnimationMixer, SkinnedMesh } from 'three';
import type { Object3D, Skeleton } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

// 每个视图持有独立骨架和播放器；几何、材质、纹理仍由加载缓存持有。
export function createAnimatedModel(source: Object3D) {
  const root = clone(source);
  const mixer = new AnimationMixer(root);
  return {
    root,
    mixer,
    // 只释放该实例持有的骨架资源，不能释放其他视图仍在使用的共享素材。
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      const skeletons = new Set<Skeleton>();
      root.traverse((node) => { if (node instanceof SkinnedMesh) skeletons.add(node.skeleton); });
      for (const skeleton of skeletons) skeleton.dispose();
    },
  };
}
