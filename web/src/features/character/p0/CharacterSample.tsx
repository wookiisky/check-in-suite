import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSampleCharacter } from './sample-character';
import { applySampleAppearance } from './sample-appearance';
import type { CharacterSampleDefinition, SampleAppearance } from './sample-appearance';

// 样片接收原始动作名，正式人物的语义动作契约在素材验收后确定。
interface CharacterSampleProps {
  modelUrl?: string; // 同源 GLB 路径。
  animationUrl?: string; // 已离线适配的补充动作 GLB。
  definition?: CharacterSampleDefinition; // 已加工四槽素材描述。
  appearance?: SampleAppearance; // 当前样片组合，不写入用户装备。
  animation: string; // 已验证的原始动作名。
  paused: boolean; // 页面统一决定暂停、隐藏与减少动效。
  position?: [number, number, number]; // 视图内的位置，不写入布局。
  rotation?: number; // Y 轴旋转弧度。
}

// 共享源文件缓存，每个挂载点拥有独立骨架与动画状态。
export function CharacterSample({ modelUrl, animationUrl, definition, appearance, animation, paused, position = [0, 0, 0], rotation = 0 }: CharacterSampleProps) {
  const assets = useLoader(GLTFLoader, [modelUrl ?? definition?.model_url ?? '/models/p0/kaykit/rogue.glb', ...(animationUrl ? [animationUrl] : [])]);
  const source = assets[0]!;
  const extra = assets[1];
  const instance = useMemo(() => createSampleCharacter(source.scene, [...source.animations, ...(extra?.animations ?? [])]), [source, extra]);
  const invalidate = useThree((state) => state.invalidate);
  const skipFrame = useRef(true);
  useLayoutEffect(() => {
    if (definition) {
      instance.root.scale.setScalar(definition.scale);
      applySampleAppearance(instance.root, definition, appearance ?? definition.defaults);
    }
    invalidate();
  }, [instance, definition, appearance, invalidate]);
  useEffect(() => { instance.play(animation); invalidate(); }, [instance, animation, invalidate]);
  useEffect(() => { skipFrame.current = true; }, [paused]);
  useEffect(() => () => instance.dispose(), [instance]);
  useFrame((_, delta) => {
    if (paused || document.visibilityState === 'hidden') { skipFrame.current = true; return; }
    if (skipFrame.current) { skipFrame.current = false; return; }
    instance.mixer.update(Math.min(delta, 0.05));
  });
  return <group position={position} rotation={[0, rotation, 0]}><primitive object={instance.root} dispose={null} /></group>;
}
