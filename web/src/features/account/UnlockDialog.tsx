import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FormFeedback } from '../../components/FormFeedback';
import content from '../../content/zh-CN.json';

// 每次进入管理创建独立密码表单，关闭后迟到响应不能重新打开管理页。
export function UnlockDialog({ client, onUnlock, onClose }: { client: ApiClient; onUnlock: (expiresAt: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancelled = useRef(false);
  function close() { if (busy) return; cancelled.current = true; onClose(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await client.request<{ management_expires_at: string }>('/management/unlock', { method: 'POST', body: { password } });
      if (!cancelled.current) onUnlock(result.management_expires_at);
    } catch (reason) { if (!cancelled.current) setError(reason); }
    finally { if (!cancelled.current) setBusy(false); }
  }
  return <Modal title={content.account.unlockTitle} onClose={close} closeDisabled={busy}>
    <form onSubmit={submit} className="form-stack">
      <label htmlFor="management-password">{content.account.managementPassword}</label><input id="management-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
      <FormFeedback error={error} />
      <div className="button-row"><button disabled={busy} type="submit">{busy ? content.account.unlocking : content.account.unlock}</button><button className="secondary" type="button" disabled={busy} onClick={close}>{content.common.cancel}</button></div>
    </form>
  </Modal>;
}
