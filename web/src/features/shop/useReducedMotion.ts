import { useEffect, useState } from 'react';

// 系统减少动效和账户偏好均生效，并响应系统设置的即时变更。
export function useReducedMotion(preference = false): boolean {
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setSystemReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return preference || systemReduced;
}
