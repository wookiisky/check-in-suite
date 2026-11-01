import { useEffect, useState } from 'react';

// 图形视图统一暂停来源；事件更新不会在每帧触发 React 渲染。
export function useGraphicsMotion(paused = false): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    const preference = () => setReduced(media.matches);
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', preference);
    visibility(); preference();
    return () => { document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', preference); };
  }, []);
  return paused || hidden || reduced;
}
