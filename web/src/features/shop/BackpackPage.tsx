import { useEffect, useRef, useState } from 'react';
import { CategoryTabs } from './CategoryTabs';
import { categoryPurchaseType, matchesCategory } from './shop-categories';
import type { CategoryFilter } from './shop-categories';
import type { Purchase, PurchaseList, ShopProps } from './types';
import { RedeemDialog } from './RedeemDialog';
import { ShopItemArtwork } from './ShopItemArtwork';
import { assetURL, shopError } from './helpers';
import content from './content.json';
import './shop.css';

// 类型查询保留后追加的画像能力；营地用途只能在已拥有订单中按能力过滤。
function purchaseQuery(filter: CategoryFilter, status: 'pending' | 'redeemed'): string {
  if (filter.group === 'all') return '';
  if (filter.group === 'reward') return new URLSearchParams({ type: 'reward', status }).toString();
  return new URLSearchParams({
    status: 'owned',
    ...(filter.group === 'appearance' && filter.category ? { type: categoryPurchaseType(filter.category) } : {}),
  }).toString();
}

// 背包只管理已购物品的查看和奖励兑现，装扮及营地操作由各自入口负责。
export function BackpackPage({ client, onBack, onIsland, onWardrobe }: ShopProps & {
  onBack: () => void;
  onIsland: () => void;
  onWardrobe: () => void;
}) {
  const [filter, setFilter] = useState<CategoryFilter>({ group: 'all', category: '' });
  const [status, setStatus] = useState<'pending' | 'redeemed'>('pending');
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [reward, setReward] = useState<Purchase | null>(null);
  const [revision, refresh] = useState(0);
  const generation = useRef(0); // 筛选或重新读取后，旧请求不得写入当前列表。
  const query = purchaseQuery(filter, status);
  const path = `/purchases${query ? `?${query}` : ''}`;

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setPurchases([]);
    setCursor(null);
    void (async () => {
      try {
        const result = await client.request<PurchaseList>(path, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== current) return;
        setPurchases(result.items);
        setCursor(result.next_cursor);
      } catch (reason) {
        if (!controller.signal.aborted && generation.current === current) setError(reason);
      } finally {
        if (!controller.signal.aborted && generation.current === current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [client, path, filter.group, filter.category, revision]);

  // 后续页沿用当前查询，保留已有内容，去重只按不可变的订单身份。
  async function more() {
    if (!cursor || loading || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await client.request<PurchaseList>(`${path}${query ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`);
      if (generation.current !== current) return;
      setPurchases((items) => [...items, ...result.items.filter((item) => !items.some((known) => known.id === item.id))]);
      setCursor(result.next_cursor);
    } catch (reason) {
      if (generation.current === current) setError(reason);
    } finally {
      if (generation.current === current) setLoadingMore(false);
    }
  }

  // 一级或二级筛选变化都重新取得订单边界，奖励默认先查看待兑现。
  function changeFilter(next: CategoryFilter) {
    if (next.group === filter.group && next.category === filter.category) return;
    generation.current += 1;
    setFilter(next);
    setStatus('pending');
    setMessage('');
  }

  // 兑现已经提交后只刷新读取，不因读取失败再次提交兑现。
  function redeemed() {
    setReward(null);
    setMessage(content.redeemSuccess);
    refresh((value) => value + 1);
  }

  const visibleItems = purchases.filter((item) => matchesCategory(item, filter));
  return <div className="shop-workspace backpack-workspace">
    <div className="shop-page-heading">
      <h1>{content.backpack}</h1>
      <button type="button" className="secondary" onClick={onBack}>{content.backHome}</button>
    </div>
    <div className="shop-actions">
      <button type="button" onClick={(event) => { event.currentTarget.focus(); onWardrobe(); }}>{content.wardrobeTitle}</button>
      <button type="button" className="secondary" onClick={onIsland}>{content.goToIsland}</button>
    </div>
    {message && <p className="shop-warning feedback-success" role="status">{message}</p>}
    <CategoryTabs value={filter} onChange={changeFilter}>
      {filter.group === 'reward' && <div className="shop-tabs" aria-label={content.rewards}>
        {(['pending', 'redeemed'] as const).map((item) => <button
          key={item} type="button" className="secondary" aria-pressed={status === item}
          onClick={() => { if (item !== status) { generation.current += 1; setStatus(item); setMessage(''); } }}
        >{content[item]}</button>)}
      </div>}
      {error !== null && <div role="alert">
        <p className="shop-error">{shopError(error)}</p>
        <button type="button" className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button>
      </div>}
      {loading && <p role="status">{content.loading}</p>}
      {!loading && <>
        {visibleItems.length === 0 && !cursor && error === null && <p>{content.emptyCategoryPurchases}</p>}
        <div className="shop-grid">
          {visibleItems.map((item) => <article className="shop-card shop-product-card" key={item.id}>
            <h3>{item.name_snapshot}</h3>
            {filter.group === 'island'
              ? <img className="shop-item-art shop-product-art" src={assetURL(item.asset_key_snapshot, item.type_snapshot === 'effect')} alt="" />
              : <ShopItemArtwork className="shop-item-art shop-product-art" item={item} />}
            {item.type_snapshot === 'reward' && (item.status === 'pending'
              ? <button type="button" aria-label={`${content.redeem} ${item.name_snapshot}`} onClick={(event) => { event.currentTarget.focus(); setReward(item); }}>{content.redeem}</button>
              : <strong>{content.redeemed}</strong>)}
          </article>)}
        </div>
      </>}
      {cursor && <div className="shop-stack">
        <p>{content.moreHint}</p>
        <button type="button" className="secondary" disabled={loading || loadingMore} onClick={() => void more()}>{loadingMore ? content.loading : content.more}</button>
      </div>}
    </CategoryTabs>
    {reward && <RedeemDialog client={client} purchase={reward} onClose={() => setReward(null)} onRedeemed={redeemed} />}
  </div>;
}
