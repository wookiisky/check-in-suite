import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGraphicsMotion } from '../../graphics/useGraphicsMotion';
import { resolveAppearance } from './character3d-appearance';
import type { AppearanceDraft, AppearanceState, CharacterAttachment, CharacterLoadStatus } from './character3d-appearance';
import { usePreparedCharacter } from './character3d-preparation';
import type { CharacterResolution } from './character3d-preparation';

// 模型对象可放在任意已有 Canvas；编辑器和营地使用同一套组装与动作实现。
export interface CharacterModel3DProps {
  snapshot: AppearanceState; // 已确认目录、库存与保存状态。
  draft?: AppearanceDraft; // 可选的完整编辑草稿。
  action?: string; // 目录声明的语义动作，默认 idle。
  paused?: boolean; // 页面或账户要求暂停。
  position?: [number, number, number]; // 场景世界位置，单位米。
  rotation?: number; // Y 轴朝向弧度。
  onStatus?: (status: CharacterLoadStatus) => void; // 显示状态，不代表 API 保存结果。
  attempt?: number; // HTML 重试操作递增的准备代次。
  attachments?: readonly CharacterAttachment[]; // 随当前活动加载并挂接的静态道具。
}

// 新资源全部准备好后一次提交节点；等待或失败时仍绘制上一套人物。
export function CharacterModel3D({ snapshot, draft, action = 'idle', paused = false, position = [0, 0, 0], rotation = 0, onStatus, attempt = 0, attachments }: CharacterModel3DProps) {
  const stopped = useGraphicsMotion(paused);
  const statusCallback = useRef(onStatus);
  useLayoutEffect(() => { statusCallback.current = onStatus; }, [onStatus]);
  const invalidate = useThree((state) => state.invalidate);
  const resolution = useMemo<CharacterResolution>(() => {
    try {
      const resolved = resolveAppearance(snapshot, draft, attachments);
      if (!resolved.definition.animations[action]) throw new Error(`CHARACTER_ACTION_MISSING: ${action}`);
      return { resolved };
    } catch (error) { return { error }; }
  }, [snapshot, draft, action, attachments]);
  const { character, status } = usePreparedCharacter(resolution, attempt);
  useLayoutEffect(() => {
    if (character && character.key === resolution.resolved?.key) { character.play(action, stopped); invalidate(); }
  }, [character, action, resolution.resolved?.key, invalidate]);
  useEffect(() => { character?.resetDelta(); }, [character, stopped]);
  useEffect(() => {
    const reset = () => character?.resetDelta();
    document.addEventListener('visibilitychange', reset);
    return () => document.removeEventListener('visibilitychange', reset);
  }, [character]);
  useEffect(() => { statusCallback.current?.(status); }, [status]);
  useFrame((_, seconds) => { character?.advance(seconds, stopped || document.visibilityState === 'hidden'); });
  return character ? <group position={position} rotation={[0, rotation, 0]}><primitive object={character.root} dispose={null} /></group> : null;
}
