import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSampleCharacter } from './sample-character';

// 样片接收原始动作名，正式人物的语义动作契约在素材验收后确定。
interface CharacterSampleProps {
  modelUrl?: string; // 同源 GLB 路径。
  animation: string; // 已验证的原始动作名。
  paused: boolean; // 页面统一决定暂停、隐藏与减少动效。
  position?: [number, number, number]; // 视图内的位置，不写入布局。
  rotation?: number; // Y 轴旋转弧度。
}

// 共享源文件缓存，每个挂载点拥有独立骨架与动画状态。
export function CharacterSample({ modelUrl = '/models/p0/kaykit/rogue.glb', animation, paused, position = [0, 0, 0], rotation = 0 }: CharacterSampleProps) {
  const source = useLoader(GLTFLoader, modelUrl);
  const instance = useMemo(() => createSampleCharacter(source.scene, source.animations), [source]);
  const skipFrame = useRef(true);
  useEffect(() => { instance.play(animation); }, [instance, animation]);
  useEffect(() => { skipFrame.current = true; }, [paused]);
  useEffect(() => () => instance.dispose(), [instance]);
  useFrame((_, delta) => {
    if (paused || document.visibilityState === 'hidden') { skipFrame.current = true; return; }
    if (skipFrame.current) { skipFrame.current = false; return; }
    instance.mixer.update(Math.min(delta, 0.05));
  });
  return <group position={position} rotation={[0, rotation, 0]}><primitive object={instance.root} dispose={null} /></group>;
}
