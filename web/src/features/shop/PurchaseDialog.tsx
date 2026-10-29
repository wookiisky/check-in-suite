import { useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiFailure } from '../../api/client';
import { createIdempotencyKey } from '../../api/idempotency-key';
import type { Camp, Product, Purchase, PurchaseResult, ShopClient, Wallet } from './types';
import { pendingPurchases } from './pending';
import { assetURL, canBuy, shopError, uncertainResult } from './helpers';
import { Price } from './Price';
import { dispatchFeedback } from '../../feedback/feedback-events';
import content from './content.json';

// 购买确认固定版本与幂等键，未知结果跨弹窗恢复原命令。
export function PurchaseDialog({
  client,
  product: initialProduct,
  wallet: initialWallet,
  onClose,
  onPurchased,
}: {
  client: ShopClient;
  product: Product;
  wallet: Wallet;
  onClose: () => void;
  onPurchased: (purchase: Purchase) => void;
}) {
  const original = pendingPurchases.get(client);
  const [product, setProduct] = useState(original?.product ?? initialProduct);
  const [wallet, setWallet] = useState(original?.wallet ?? initialWallet);
  const [pending, setPending] = useState(original ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [available, setAvailable] = useState(true);
  const completed = useRef(false); // 已确认成交后不再提交或重播成功反馈。
  // 结果未知沿用原命令，只有第一次确认成交才发出反馈。
  async function submit() {
    if (busy || completed.current) return;
    const command = pending ?? {
      key: createIdempotencyKey(),
      product,
      wallet,
      body: Object.freeze({
        product_id: product.id,
        expected_product_version: product.version,
        expected_wallet_version: wallet.version,
      }),
    };
    pendingPurchases.set(client, command);
    setPending(command);
    setBusy(true);
    setError(null);
    try {
      const result = await client.request<PurchaseResult>('/purchases', {
        method: 'POST',
        body: command.body,
        idempotencyKey: command.key,
      });
      pendingPurchases.delete(client);
      setPending(null);
      completed.current = true;
      dispatchFeedback('purchase');
      onPurchased(result.purchase);
    } catch (reason) {
      setError(reason);
      if (!uncertainResult(reason)) {
        pendingPurchases.delete(client);
        setPending(null);
        if (
          reason instanceof ApiFailure &&
          [
            'PRODUCT_CHANGED',
            'WALLET_CHANGED',
            'INSUFFICIENT_BALANCE',
            'OUT_OF_STOCK',
            'PRODUCT_UNAVAILABLE',
            'ALREADY_OWNED',
          ].includes(reason.detail.code)
        )
          setNeedsRefresh(true);
      }
    } finally {
      setBusy(false);
    }
  }
  async function refreshOffer() {
    setBusy(true);
    setError(null);
    try {
      const [products, snapshot] = await Promise.all([
        client.request<{ items: Product[] }>('/products'),
        client.request<Camp>('/camp'),
      ]);
      const current = products.items.find((item) => item.id === product.id);
      if (!current) {
        setAvailable(false);
        return;
      }
      setProduct(current);
      setWallet(snapshot.wallet);
      setNeedsRefresh(false);
      setReviewed(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={content.confirmPurchase} onClose={onClose} closeDisabled={busy}>
      <div className="shop-confirm-item">
        <img src={assetURL(product.asset_key, product.type === 'effect')} alt="" />
        <h3>{product.name}</h3>
      </div>
      <p>{content.purchaseCost}</p>
      <Price coins={product.coin_price} diamonds={product.diamond_price} />
      <p>{content.afterPurchase}</p>
      <Price
        coins={wallet.coins - product.coin_price}
        diamonds={wallet.diamonds - product.diamond_price}
      />
      {!canBuy(product, wallet) && !pending && (
        <p className="shop-hint">
          {product.owned && !product.repeatable
            ? content.owned
            : product.stock === 0
              ? content.soldOut
              : content.insufficient}
        </p>
      )}
      {pending && !busy && <p className="shop-warning">{content.purchasePending}</p>}
      {reviewed && <p className="shop-warning">{content.reviewOffer}</p>}
      {!available && <p role="alert">{content.purchaseClosed}</p>}
      {error !== null && (
        <p className="shop-error" role="alert">
          {shopError(error)}
        </p>
      )}
      <div className="button-row">
        {needsRefresh && available && (
          <button type="button" disabled={busy} onClick={() => void refreshOffer()}>
            {content.refreshOffer}
          </button>
        )}
        <button
          type="button"
          disabled={busy || completed.current || (!pending && (needsRefresh || !available || !canBuy(product, wallet)))}
          onClick={() => void submit()}
        >
          {busy ? content.purchasing : pending ? content.recoverPurchase : content.confirmPurchase}
        </button>
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>
          {content.close}
        </button>
      </div>
    </Modal>
  );
}
