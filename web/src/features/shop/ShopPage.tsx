import { useEffect, useRef, useState } from 'react';
import type { Camp, Product, Purchase, PurchaseList, ShopProps } from './types';
import { CharacterPanel } from './CharacterPanel';
import { Price } from './Price';
import { PurchaseDialog } from './PurchaseDialog';
import { RedeemDialog } from './RedeemDialog';
import { Wardrobe } from './Wardrobe';
import { pendingPurchases } from './pending';
import { assetURL, canBuy, purchaseTime, shopError } from './helpers';
import content from './content.json';
import './shop.css';

type ShopTab = 'browse' | 'wardrobe' | 'rewards';

// 页面进入、筛选和写成功才加载，结果未知时始终先恢复原购买。
export function ShopPage({ client, session }: ShopProps) {
  const [tab, setTab] = useState<ShopTab>('browse');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('pending');
  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [snapshot, setSnapshot] = useState<Camp | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Product | null>(null);
  const [reward, setReward] = useState<Purchase | null>(null);
  const generation = useRef(0);
  const pending = pendingPurchases.get(client);
  const query = new URLSearchParams(
    tab === 'rewards' ? { type: 'reward', status } : { status: 'owned', ...(type ? { type } : {}) },
  ).toString();

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    setPurchases([]);
    setCursor(null);
    void (async () => {
      try {
        const [camp, result] = await Promise.all([
          client.request<Camp>('/camp', { signal: controller.signal }),
          tab === 'browse'
            ? client.request<{ items: Product[] }>('/products', { signal: controller.signal })
            : client.request<PurchaseList>(`/purchases?${query}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || generation.current !== current) return;
        setSnapshot(camp);
        if (tab === 'browse') setProducts(result.items as Product[]);
        else {
          setPurchases(result.items as Purchase[]);
          setCursor((result as PurchaseList).next_cursor);
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [client, tab, query, revision]);

  async function more() {
    if (!cursor || loading) return;
    const current = generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.request<PurchaseList>(
        `/purchases?${query}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (generation.current !== current) return;
      setPurchases((items) => [
        ...items,
        ...result.items.filter((item) => !items.some((known) => known.id === item.id)),
      ]);
      setCursor(result.next_cursor);
    } catch (reason) {
      if (generation.current === current) setError(reason);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }
  function changeTab(next: ShopTab) {
    setTab(next);
    setType('');
    setMessage('');
  }
  function purchased(item: Purchase) {
    setSelected(null);
    setMessage(item.type_snapshot === 'reward' ? content.rewardPurchased : content.purchaseSuccess);
    setTab(item.type_snapshot === 'reward' ? 'rewards' : 'wardrobe');
    setType('');
    setStatus('pending');
    refresh((value) => value + 1);
  }
  async function toggle(item: Purchase, equip: boolean) {
    setWriting(true);
    setError(null);
    setMessage('');
    try {
      if (item.type_snapshot === 'accessory')
        await client.request(`/equipment/accessories/${item.id}`, {
          method: equip ? 'PUT' : 'DELETE',
        });
      else
        await client.request(`/equipment/${item.type_snapshot}`, {
          method: 'PUT',
          body: { purchase_id: equip ? item.id : null },
        });
      setMessage(content.equipmentSaved);
      refresh((value) => value + 1);
    } catch (reason) {
      setError(reason);
    } finally {
      setWriting(false);
    }
  }
  const visibleProducts = products.filter((item) => !type || item.type === type);
  const confirmationWallet = pending?.wallet ?? snapshot?.wallet;
  return (
    <div className="shop-workspace">
      <h1>{content.title}</h1>
      <div className="shop-tabs">
        {(['browse', 'wardrobe', 'rewards'] as const).map((item) => (
          <button
            type="button"
            key={item}
            className="secondary"
            aria-pressed={tab === item}
            onClick={() => changeTab(item)}
          >
            {content[item]}
          </button>
        ))}
      </div>
      {snapshot && (
        <div className="shop-wallet">
          <strong>{content.balance}</strong>
          <Price coins={snapshot.wallet.coins} diamonds={snapshot.wallet.diamonds} />
          {(snapshot.wallet.coins < 0 || snapshot.wallet.diamonds < 0) && (
            <p className="shop-hint">{content.negativeBalance}</p>
          )}
        </div>
      )}
      {message && (
        <p className="shop-warning" role="status">
          {message}
        </p>
      )}
      {pending && (
        <div className="shop-warning">
          <p>{content.purchasePending}</p>
          <button
            onClick={(event) => {
              event.currentTarget.focus();
              setSelected(pending.product);
            }}
          >
            {content.recoverPurchase}
          </button>
        </div>
      )}
      {error !== null && (
        <div role="alert">
          <p className="shop-error">{shopError(error)}</p>
          <button className="secondary" onClick={() => refresh((value) => value + 1)}>
            {content.reload}
          </button>
        </div>
      )}
      {tab === 'rewards' ? (
        <div className="shop-tabs">
          {(['pending', 'redeemed'] as const).map((item) => (
            <button
              type="button"
              className="secondary"
              aria-pressed={status === item}
              key={item}
              onClick={() => setStatus(item)}
            >
              {content[item]}
            </button>
          ))}
        </div>
      ) : (
        <label>
          {content.typeFilter}
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">{content.allTypes}</option>
            {(tab === 'browse'
              ? (['title', 'avatar', 'accessory', 'reward'] as const)
              : (['title', 'avatar', 'accessory'] as const)
            ).map((item) => (
              <option value={item} key={item}>
                {content.types[item]}
              </option>
            ))}
          </select>
        </label>
      )}
      {loading && <p role="status">{content.loading}</p>}
      {tab === 'browse' && !loading && snapshot && (
        <>
          {visibleProducts.length === 0 && <p>{content.emptyProducts}</p>}
          <div className="shop-grid">
            {visibleProducts.map((item) => (
              <article className="shop-card" key={item.id}>
                <img className="shop-item-art" src={assetURL(item.asset_key)} alt="" />
                <h3>{item.name}</h3>
                <p className="shop-hint">{content.types[item.type]}</p>
                <p>{item.description}</p>
                <Price coins={item.coin_price} diamonds={item.diamond_price} />
                <p>
                  {content.stock} {item.stock ?? content.unlimited}
                </p>
                <button
                  type="button"
                  disabled={Boolean(pending) || !canBuy(item, snapshot.wallet)}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setSelected(item);
                  }}
                  aria-label={`${content.buy} ${item.name}`}
                >
                  {item.owned
                    ? content.owned
                    : item.stock === 0
                      ? content.soldOut
                      : !canBuy(item, snapshot.wallet)
                        ? content.insufficient
                        : content.buy}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {tab === 'wardrobe' && snapshot && (
        <div className="shop-wardrobe-layout">
          <section>
            <Wardrobe
              items={purchases}
              equipment={snapshot.equipment}
              busy={writing || loading}
              onToggle={(item, equip) => void toggle(item, equip)}
            />
          </section>
          <aside className="panel">
            <CharacterPanel
              equipment={snapshot.equipment}
              displayName={session.account.display_name}
            />
          </aside>
        </div>
      )}
      {tab === 'rewards' && !loading && (
        <>
          {purchases.length === 0 && <p>{content.emptyPurchases}</p>}
          <div className="shop-grid">
            {purchases.map((item) => (
              <article className="shop-card" key={item.id}>
                <img className="shop-item-art" src={assetURL(item.asset_key_snapshot)} alt="" />
                <h3>{item.name_snapshot}</h3>
                <p>{item.description_snapshot}</p>
                <p className="shop-hint">
                  {content.purchasedAt} {purchaseTime(item.created_at)}
                </p>
                <strong>{item.status === 'redeemed' ? content.redeemed : content.pending}</strong>
                {item.redeemed_at && (
                  <p className="shop-hint">
                    {content.redeemedAt} {purchaseTime(item.redeemed_at)}
                  </p>
                )}
                {item.status === 'pending' && (
                  <button
                    onClick={(event) => {
                      event.currentTarget.focus();
                      setReward(item);
                    }}
                    aria-label={`${content.redeem} ${item.name_snapshot}`}
                  >
                    {content.redeem}
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {cursor && (
        <div className="shop-stack">
          <p className="shop-hint">{content.moreHint}</p>
          <button className="secondary" disabled={loading} onClick={() => void more()}>
            {content.more}
          </button>
        </div>
      )}
      {selected && confirmationWallet && (
        <PurchaseDialog
          client={client}
          product={selected}
          wallet={confirmationWallet}
          onClose={() => {
            setSelected(null);
            refresh((value) => value + 1);
          }}
          onPurchased={purchased}
        />
      )}
      {reward && (
        <RedeemDialog
          client={client}
          purchase={reward}
          onClose={() => setReward(null)}
          onRedeemed={() => {
            setReward(null);
            setMessage(content.redeemSuccess);
            refresh((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
