import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { IslandAccess } from './island-activity-access';
export type { IslandAccess } from './island-activity-access';
export { allowedIslandActivities } from './island-activity-access';

// 只摘取服务端资格，避免初始页面响应把布局带入另一份状态。
function activityAccess(state: IslandAccess): IslandAccess {
  return { today: state.today, expires_at: state.expires_at, activity_access: state.activity_access };
}

// 正在重新确认或读取失败时，仅保留不需要打卡的自由活动。
function invalidateAccess(access: IslandAccess | null): IslandAccess | null {
  return access && { ...access, activity_access: access.activity_access.map((item) => ({ ...item, available: item.tasks.length === 0 && item.available })) };
}

// 无初始资格时主动读取；跨日和恢复前台仅刷新资格，不替换布局。
export function useIslandActivityAccess(client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>, state?: IslandAccess | null) {
  const [access, setAccess] = useState<IslandAccess | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(!state);
  const request = useRef<AbortController | null>(null);
  const now = useCallback(() => client.now?.().getTime() ?? Date.now(), [client]);

  // 后发请求取消前一请求；即使替身或网络仍返回，也不采用已取消的结果。
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAccess(invalidateAccess); setPending(true); setError(null);
    void client.request<IslandAccess>('/island/activity-access', { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      const received = activityAccess(next);
      if (Date.parse(received.expires_at) <= now()) {
        setAccess(invalidateAccess(received));
        setError(new Error('ISLAND_ACCESS_EXPIRED'));
      } else setAccess(received);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
    }).finally(() => {
      if (!controller.signal.aborted) setPending(false);
    });
  }, [client, now]);

  useEffect(() => {
    if (!state) { refresh(); return; }
    request.current?.abort();
    const next = activityAccess(state);
    setError(null); setPending(false);
    if (Date.parse(next.expires_at) > now()) setAccess(next);
    else { setAccess(invalidateAccess(next)); refresh(); }
  }, [state, refresh, now]);

  useEffect(() => {
    if (!access) return;
    const delay = Date.parse(access.expires_at) - now();
    if (delay <= 0) return;
    const timeout = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timeout);
  }, [access, refresh, now]);

  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      request.current?.abort();
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  return { access, error, pending, refresh, loading: pending, retry: refresh };
}
