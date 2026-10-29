import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { IslandActivity, IslandState } from './island-types';

// 活动资格独立于布局；刷新读取绝不替换页面里的布置草稿。
export type IslandAccess = Pick<IslandState, 'today' | 'expires_at' | 'activity_access'>;

// 每次使用时检查期限，后台节流后的旧计时器也不能延长昨日资格。
export function allowedIslandActivities(access: IslandAccess | null, now = Date.now()): IslandActivity[] {
  if (!access) return [];
  const valid = Date.parse(access.expires_at) > now;
  return access.activity_access.filter((item) => item.available && (valid || item.tasks.length === 0)).map((item) => item.activity);
}

// 只摘取服务端资格，避免读取或保存响应把布局带入另一份状态。
function activityAccess(state: IslandState): IslandAccess {
  return { today: state.today, expires_at: state.expires_at, activity_access: state.activity_access };
}

// 正在重新确认或读取失败时，仅保留不需要打卡的自由活动。
function invalidateAccess(access: IslandAccess | null): IslandAccess | null {
  return access && { ...access, activity_access: access.activity_access.map((item) => ({ ...item, available: item.tasks.length === 0 && item.available })) };
}

// 初次读取和保存复用页面响应，跨日与恢复前台只重新读取资格。
export function useIslandActivityAccess(client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>, state: IslandState | null) {
  const [access, setAccess] = useState<IslandAccess | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const now = useCallback(() => client.now?.().getTime() ?? Date.now(), [client]);

  // 后发请求取消前一请求；即使替身或网络仍返回，也不采用已取消的结果。
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAccess(invalidateAccess); setPending(true); setError(null);
    void client.request<IslandState>('/island', { signal: controller.signal }).then((next) => {
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
    if (!state) return;
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

  return { access, error, pending, refresh };
}
