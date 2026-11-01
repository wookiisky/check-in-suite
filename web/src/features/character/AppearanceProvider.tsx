import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../api/client';
import type { components } from '../../api/schema';

type AppearanceState = components['schemas']['AppearanceState'];

// 共享层只持有服务端确认的外观；编辑草稿由弹窗自己管理。
interface AppearanceContextValue {
  snapshot: AppearanceState | null; // 第一次读取完成前没有已保存外观。
  loading: boolean; // 重读时保留当前快照。
  error: unknown; // 读取失败不清除已展示外观。
  refresh: () => Promise<AppearanceState | null>; // 显式读取最新库存与外观。
  publishSaved: (snapshot: AppearanceState) => void; // 直接发布完整保存响应。
}

const AppearanceContext = createContext<AppearanceContextValue>({ snapshot: null, loading: false, error: null, refresh: async () => null, publishSaved: () => {} });

// 外层按登录会话设置 key，退出登录时也主动清除旧快照和未完成读取。
export function AppearanceProvider({ client, active, children }: { client: Pick<ApiClient, 'request'>; active: boolean; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AppearanceState | null>(null);
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<unknown>(null);
  const current = useRef<AppearanceState | null>(null); // 同步版本判断，避免批量 React 更新读取旧闭包。
  const generation = useRef(0); // 新读取或保存发布会使旧读取失效。
  const controller = useRef<AbortController | null>(null); // 只取消共享层自身的 GET。
  const enabled = useRef(active); // 旧回调不能在退出登录后发布。
  const mounted = useRef(true); // 卸载后不再向共享状态写入。
  enabled.current = active;

  // 同版本可带回新增库存，只拒绝确实更旧的外观版本。
  const accept = useCallback((next: AppearanceState) => {
    if (current.current && next.version < current.current.version) return false;
    current.current = next; setSnapshot(next); setError(null);
    return true;
  }, []);

  // 只接受最后一次请求；取消较早读取不影响其他模块的请求。
  const refresh = useCallback(async () => {
    if (!enabled.current || !mounted.current) return null;
    const request = ++generation.current;
    controller.current?.abort();
    const read = new AbortController(); controller.current = read;
    setLoading(true); setError(null);
    try {
      const next = await client.request<AppearanceState>('/appearance', { signal: read.signal });
      if (read.signal.aborted || request !== generation.current || !mounted.current) return null;
      return accept(next) ? next : null;
    } catch (reason) {
      if (!read.signal.aborted && request === generation.current && mounted.current) setError(reason);
      return null;
    } finally {
      if (!read.signal.aborted && request === generation.current && mounted.current) setLoading(false);
    }
  }, [client, accept]);

  // 保存结果先使旧 GET 失效，不为同步人物再读取营地聚合数据。
  const publishSaved = useCallback((next: AppearanceState) => {
    if (!enabled.current || !mounted.current || current.current && next.version < current.current.version) return;
    generation.current += 1; controller.current?.abort();
    accept(next); setLoading(false);
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    if (active) void refresh();
    else { generation.current += 1; controller.current?.abort(); current.current = null; setSnapshot(null); setLoading(false); setError(null); }
    return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); };
  }, [active, refresh]);
  const value = useMemo(() => ({ snapshot, loading, error, refresh, publishSaved }), [snapshot, loading, error, refresh, publishSaved]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

// 人物视图与编辑成功回调共用已确认快照，不能向这里发布本地草稿。
export function useAppearance() { return useContext(AppearanceContext); }
