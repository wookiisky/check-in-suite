import { useEffect, useState } from 'react';
import { prepareCharacter } from './character3d-model';
import type { PreparedCharacter } from './character3d-model';
import type { CharacterLoadStatus, ResolvedAppearance } from './character3d-appearance';

// 解析失败也保留上一个实例，错误状态与显示内容分开。
export type CharacterResolution = { resolved: ResolvedAppearance; error?: never } | { resolved?: never; error: unknown };

// 资源身份不变时，库存刷新不会重建骨架；显式重试通过 attempt 发起新准备。
export function usePreparedCharacter(resolution: CharacterResolution, attempt = 0) {
  const [character, setCharacter] = useState<PreparedCharacter | null>(null);
  const [status, setStatus] = useState<CharacterLoadStatus>({ phase: 'loading' });
  const resolved = resolution.resolved;
  useEffect(() => {
    if (!resolved) { setStatus({ phase: 'error', error: resolution.error }); return; }
    let active = true;
    setStatus({ phase: 'loading' });
    void prepareCharacter(resolved).then((next) => {
      if (!active) { next.dispose(); return; }
      setCharacter(next); setStatus({ phase: 'ready' });
    }).catch((error: unknown) => { if (active) setStatus({ phase: 'error', error }); });
    return () => { active = false; };
  }, [resolved?.key, resolution.error, attempt]);
  // 新实例完成 React 提交后才释放旧实例；等待或错误期间继续持有旧画面的资源。
  useEffect(() => () => character?.dispose(), [character]);
  return { character, status };
}
