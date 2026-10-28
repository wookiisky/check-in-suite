import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';

// 依据服务端时差，在台北午夜和恢复可见时检查跨日，不因聚焦或联网刷新。
export function useBusinessToday(client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>, session: Session): string {
  const [today, setToday] = useState(() => client.now ? new Date(client.now().getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : session.today);
  useEffect(() => {
    const offset = Date.parse(session.server_now) - Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const now = () => client.now?.().getTime() ?? Date.now() + offset;
    const currentDate = () => new Date(now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const check = () => {
      const date = currentDate();
      setToday((old) => old === date ? old : date);
      clearTimeout(timer);
      const midnight = Date.parse(`${date}T00:00:00+08:00`) + 24 * 60 * 60 * 1000;
      timer = setTimeout(check, Math.max(1, midnight - now()));
    };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [client, session.server_now, session.today]);
  return today;
}
