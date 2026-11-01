import { useEffect, useState } from 'react';
import type { Camp, Product, Purchase, ShopProps } from './types';
import { useWalletSync } from '../../components/WalletContext';
import { PurchaseDialog } from './PurchaseDialog';
import { ShopItemArtwork } from './ShopItemArtwork';
import { CategoryTabs } from './CategoryTabs';
import { isWearableSlot, matchesCategory, type CategoryFilter } from './shop-categories';
import { pendingPurchases } from './pending';
import { canBuy, shopError } from './helpers';
import content from './content.json';
import { useAppearance } from '../character/AppearanceProvider';
import './shop.css';

// 商店只浏览与购买，分类属于当前页面，成交和恢复均不改变选择。
export function ShopPage({ client, onBackpack }: ShopProps & { onBackpack?: () => void }) {
  const publishWallet = useWalletSync();
  const appearance = useAppearance();
  const [filter, setFilter] = useState<CategoryFilter>({ group: 'all', category: '' });
  const [products, setProducts] = useState<Product[]>([]);
  const [snapshot, setSnapshot] = useState<Camp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Product | null>(null);
  const pending = pendingPurchases.get(client);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [camp, result] = await Promise.all([
          client.request<Camp>('/camp', { signal: controller.signal }),
          client.request<{ items: Product[] }>('/products', { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setSnapshot(camp);
        publishWallet(camp.wallet);
        setProducts(result.items);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [client, revision, publishWallet]);

  // 成功只刷新当前报价；读取失败通过重读恢复，不能重放购买反馈。
  function purchased(item: Purchase) {
    setSelected(null);
    setMessage(item.type_snapshot === 'reward' ? content.rewardPurchased : item.type_snapshot === 'island' ? content.islandPurchased : content.purchaseSuccess);
    refresh((value) => value + 1);
  }
  const catalogReady = !isWearableSlot(filter.category) || appearance.snapshot !== null;
  const readError = error ?? (!catalogReady ? appearance.error : null);
  const visibleProducts = products.filter((item) => matchesCategory(item, filter, appearance.snapshot?.wearables));
  const confirmationWallet = pending?.wallet ?? snapshot?.wallet;
  return <div className="shop-workspace">
    <div className="shop-page-heading"><h1>{content.title}</h1>{onBackpack && <button type="button" className="secondary" onClick={onBackpack}>{content.backpack}</button>}</div>
    {message && <p className="shop-warning feedback-success" role="status">{message}</p>}
    {pending && <div className="shop-warning"><p>{content.purchasePending}</p><button onClick={(event) => { event.currentTarget.focus(); setSelected(pending.product); }}>{content.recoverPurchase}</button></div>}
    {readError !== null && <div role="alert"><p className="shop-error">{shopError(readError)}</p><button className="secondary" onClick={() => { if (!catalogReady) void appearance.refresh(); if (catalogReady || error !== null) refresh((value) => value + 1); }}>{content.reload}</button></div>}
    <CategoryTabs value={filter} onChange={setFilter}>
      {(loading || !catalogReady && readError === null) && <p role="status">{content.loading}</p>}
      {!loading && snapshot && catalogReady && <>
        {visibleProducts.length === 0 && error === null && <p>{filter.group === 'all' ? content.emptyProducts : content.emptyCategoryProducts}</p>}
        <div className="shop-grid">
          {visibleProducts.map((item) => <article className="shop-card shop-product-card" key={item.id}>
            <h3>{item.name}</h3>
            <ShopItemArtwork className="shop-item-art shop-product-art" item={item} />
            <div className="shop-product-footer">
              <button className="shop-product-buy" type="button"
                disabled={Boolean(pending) || error !== null || !canBuy(item, snapshot.wallet)}
                onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}
                aria-label={`${content.buy} ${item.name}`}
                aria-description={[
                  `${content.coins} ${item.coin_price}`,
                  item.diamond_price > 0 ? `${content.diamonds} ${item.diamond_price}` : null,
                  item.owned && !item.repeatable ? content.owned : item.stock === 0 ? content.soldOut : !canBuy(item, snapshot.wallet) ? content.insufficient : null,
                ].filter(Boolean).join('，')}>
                <span><img src="/api/v1/assets/coin-v1" alt={content.coins} /><strong>{item.coin_price}</strong></span>
                {item.diamond_price > 0 && <span><img src="/api/v1/assets/gem-v1" alt={content.diamonds} /><strong>{item.diamond_price}</strong></span>}
              </button>
              <span className="shop-product-owned"><img src="/api/v1/assets/icon-backpack-v1" alt={content.ownedCount} /><strong>{item.owned_count ?? (item.owned ? 1 : 0)}</strong></span>
            </div>
          </article>)}
        </div>
      </>}
    </CategoryTabs>
    {selected && confirmationWallet && <PurchaseDialog client={client} product={selected} wallet={confirmationWallet}
      onClose={() => { setSelected(null); refresh((value) => value + 1); }} onPurchased={purchased} />}
  </div>;
}
