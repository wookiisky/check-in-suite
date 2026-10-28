import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import type { Purchase, ShopClient } from './types';
import { shopError } from './helpers';
import content from './content.json';

// 兑现密码仅属于这一次操作，不读取或复用管理解锁状态。
export function RedeemDialog({
  client,
  purchase,
  onClose,
  onRedeemed,
}: {
  client: ShopClient;
  purchase: Purchase;
  onClose: () => void;
  onRedeemed: (purchase: Purchase) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onRedeemed(
        await client.request<Purchase>(`/purchases/${purchase.id}/redeem`, {
          method: 'POST',
          body: { password },
        }),
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={content.redeemTitle} onClose={onClose} closeDisabled={busy}>
      <h3>{purchase.name_snapshot}</h3>
      <p>{content.redeemHint}</p>
      <form className="form-stack" onSubmit={submit}>
        <label htmlFor="redeem-password">{content.redeemPassword}</label>
        <input
          id="redeem-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error !== null && (
          <p role="alert" className="shop-error">
            {shopError(error)}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? content.saving : content.confirmRedeem}
        </button>
      </form>
    </Modal>
  );
}
