import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import type { components } from '../api/schema';

type Wallet = components['schemas']['Wallet'];
type Camp = components['schemas']['CampResponse'];

// 当前会话共享已确认的钱包；业务组件只发布服务端余额，不自行加减。
interface WalletState {
  wallet: Wallet | null; // 首次读取成功前没有可展示的余额。
  error: unknown; // 首次读取失败时允许用户重试。
  loading: boolean; // 读取期间保留已有余额。
  updateWallet: (wallet: Wallet) => void; // 只接受更高版本的服务端快照。
  reload: () => void; // 显式重读，不触发业务写入。
}

const WalletContext = createContext<WalletState>({ wallet: null, error: null, loading: false, updateWallet: () => {}, reload: () => {} });

// Provider按登录会话挂载，页面切换不清空余额或重新发起初始化读取。
export function WalletProvider({ client, active, children }: {
  client: Pick<ApiClient, 'request'>;
  active: boolean;
  children: ReactNode;
}) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(active);
  const [attempt, setAttempt] = useState(0);
  // 幂等回放携带原成交回执，不能用旧版本回退当前钱包。
  const updateWallet = useCallback((next: Wallet) => {
    setWallet((current) => current && current.version >= next.version ? current : next);
    setError(null);
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.request<Camp>('/camp', { signal: controller.signal }).then((snapshot) => {
      if (!controller.signal.aborted) updateWallet(snapshot.wallet);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, active, attempt, updateWallet]);
  return <WalletContext.Provider value={{ wallet, error, loading, updateWallet, reload: () => setAttempt((value) => value + 1) }}>{children}</WalletContext.Provider>;
}

// 全局展示读取钱包和初次加载状态。
export function useWallet() { return useContext(WalletContext); }

// 独立页面测试不必安装Provider，真实应用统一从服务端回执同步。
export function useWalletSync() { return useContext(WalletContext).updateWallet; }
