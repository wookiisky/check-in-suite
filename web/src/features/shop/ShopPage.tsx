import { useEffect, useState } from 'react';
import type { components } from '../../api/schema';
import { NumberedPagination } from '../../components/NumberedPagination';
import { ViewTabs } from '../../components/ViewTabs';
import { useWallet } from '../../components/WalletContext';
import { useAppearance } from '../character/AppearanceProvider';
import { PurchaseDialog } from './PurchaseDialog';
import { ShopItemArtwork } from './ShopItemArtwork';
import { appearanceCategories, categoryLabel } from './shop-categories';
import { pendingPurchases } from './pending';
import { canBuy, shopError } from './helpers';
import type { Product, Purchase, ShopProps, Wallet } from './types';
import content from './content.json';
import './shop.css';

type ShopSnapshot = components['schemas']['ShopPage'];
type ShopGroup = 'appearance' | 'camp';

const groups = [
  { id: 'appearance', label: content.categoryGroups.appearance },
  { id: 'camp', label: content.shopCamp },
] as const;
const appearanceTabs = appearanceCategories.map((id) => ({ id, label: categoryLabel(id) }));
const pageSize = 24;

interface ShopSelection {
  group: ShopGroup; // 一级分类。
  category: string; // 空值显示该组全部商品。
  page: number; // 当前请求的页码。
}

interface PurchasedCard {
  item: Product; // 当页保留的购买反馈。
  index: number; // 成交前的显示位置。
}

// 同一报价、人物、装扮、营地物件或场景共享成交结果。
function samePurchasedItem(product: Product, purchase: Purchase) {
  if (product.id === purchase.product_id) return true;
  if (product.type !== purchase.type_snapshot) return false;
  return !!(
    product.character_key && product.character_key === purchase.character_key ||
    product.wearable_key && product.wearable_key === purchase.wearable_key ||
    product.island_item_key && product.island_item_key === purchase.island_item_key ||
    product.scene_key && product.scene_key === purchase.scene_key
  );
}

// 成交卡片留在原处，可购商品单独补位，页码仍按可购目录计算。
function displayProducts(products: readonly Product[], cards: readonly PurchasedCard[]) {
  const purchased = new Set(cards.map(({ item }) => item.id));
  const result = products.filter((item) => !item.owned && !purchased.has(item.id));
  for (const { item, index } of cards) result.splice(index, 0, item);
  return result;
}

// 商店只浏览未购报价，成交后保留当页并直接使用回执的钱包。
export function ShopPage({ client, onAppearance, initialGroup }: ShopProps & { onAppearance?: () => void; initialGroup?: 'scene' }) {
  const { wallet: sharedWallet, updateWallet } = useWallet();
  const { refresh: refreshAppearance } = useAppearance();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [selection, setSelection] = useState<ShopSelection>({ group: initialGroup ? 'camp' : 'appearance', category: initialGroup ?? '', page: 1 });
  const [campCategories, setCampCategories] = useState(['scene']);
  const [snapshot, setSnapshot] = useState<ShopSnapshot | null>(null);
  const [purchasedCards, setPurchasedCards] = useState<PurchasedCard[]>([]);
  const [pinnedPage, setPinnedPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Product | null>(null);
  const [buyAllEnabled, setBuyAllEnabled] = useState(false);
  const [buyingAll, setBuyingAll] = useState(false);
  const [buyAllError, setBuyAllError] = useState<unknown>(null);
  const pending = pendingPurchases.get(client);

  useEffect(() => {
    const controller = new AbortController();
    const { group, category, page } = selection;
    const query = new URLSearchParams({ group, category, page: String(page), limit: String(pageSize) });
    void client.request<ShopSnapshot>(`/shop/products?${query}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSnapshot(result);
      setBuyAllEnabled(result.development_buy_all === true);
      if (group === 'camp') setCampCategories(result.camp_categories);
      setWallet((before) => before && before.version > result.wallet.version ? before : result.wallet);
      updateWallet(result.wallet);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [client, selection, revision, updateWallet]);

  const currentPage = pinnedPage ?? snapshot?.page ?? selection.page;
  const totalPages = Math.max(currentPage, Math.ceil((snapshot?.total ?? 0) / pageSize));
  const currentWallet = sharedWallet && (!wallet || sharedWallet.version >= wallet.version) ? sharedWallet : wallet;
  const products = displayProducts(snapshot && (pinnedPage === null || pinnedPage === snapshot.page) ? snapshot.items : [], purchasedCards);

  // 切换类别或页码后不再保留上一次浏览的置灰商品。
  function browse(next: ShopSelection) {
    if (next.group === selection.group && next.category === selection.category && next.page === currentPage) return;
    setSelection(next);
    setSnapshot(null);
    setPurchasedCards([]);
    setPinnedPage(null);
    setError(null);
    setLoading(true);
  }

  // 重读只更新可购商品，既有成交反馈和分类仍保留。
  function reload() {
    setError(null);
    setLoading(true);
    refresh((value) => value + 1);
  }

  // 批量购买后清空旧报价并重读目录与装扮库存。
  async function buyAll() {
    setBuyingAll(true);
    setBuyAllError(null);
    setMessage('');
    try {
      const receipt = await client.request<Wallet>('/shop/development/buy-all', { method: 'POST' });
      setWallet((before) => before && before.version > receipt.version ? before : receipt);
      updateWallet(receipt);
      setSnapshot(null);
      setPurchasedCards([]);
      setPinnedPage(null);
      reload();
      void refreshAppearance();
      setMessage(content.buyAllSuccess);
    } catch (reason) {
      setBuyAllError(reason);
    } finally {
      setBuyingAll(false);
    }
  }

  // 采用回执更新余额，跨页的目录在后台补齐边界。
  function purchased(order: Purchase, receiptWallet: Wallet) {
    setSelected(null);
    setWallet((before) => before && before.version > receiptWallet.version ? before : receiptWallet);
    const cards = products.flatMap((item, index) => {
      if (!item.owned && !samePurchasedItem(item, order)) return [];
      return [{ item: item.owned ? item : { ...item, owned: true, owned_count: (item.owned_count ?? 0) + 1 }, index }];
    });
    setPurchasedCards(cards);
    if (cards.length) setPinnedPage(currentPage);
    if (totalPages > 1) reload();
    setMessage(order.type_snapshot === 'scene' ? content.scenePurchased : order.type_snapshot === 'island' ? content.islandPurchased : content.purchaseSuccess);
  }

  const labels: Readonly<Record<string, string>> = content.campCategories;
  const detailTabs = [
    { id: '', label: content.categoryGroups.all },
    ...(selection.group === 'appearance' ? appearanceTabs : campCategories.map((id) => ({ id, label: labels[id] ?? id }))),
  ];
  const confirmationWallet = pending?.wallet ?? currentWallet;
  const actions = (onAppearance || buyAllEnabled) && <div className="shop-category-actions">
    {onAppearance && <button type="button" className="secondary" onClick={onAppearance}>{content.openAppearance}</button>}
    {buyAllEnabled && <button type="button" className="secondary" disabled={buyingAll || Boolean(pending) || selected !== null}
      onClick={() => void buyAll()}>{buyingAll ? content.purchasing : content.buyAll}</button>}
  </div>;
  return <div className="shop-workspace">
    {message && <p className="shop-warning feedback-success" role="status">{message}</p>}
    {buyAllError !== null && <p className="shop-error" role="alert">{shopError(buyAllError)}</p>}
    {pending && <div className="shop-warning"><p>{content.purchasePending}</p><button onClick={() => setSelected(pending.product)}>{content.recoverPurchase}</button></div>}
    {error !== null && <div role="alert"><p className="shop-error">{shopError(error)}</p><button className="secondary" onClick={reload}>{content.reload}</button></div>}
    <div className="shop-categories">
      <ViewTabs label={content.categoryGroupLabel} className="shop-category-tabs" actions={actions} panelClassName="shop-category-panel"
        items={groups} value={selection.group} onChange={(group) => browse({ group, category: '', page: 1 })}>
        <ViewTabs label={selection.group === 'appearance' ? content.categoryDetailLabel : content.campCategoryLabel}
          className="shop-category-tabs shop-category-details" items={detailTabs} value={selection.category}
          onChange={(category) => browse({ ...selection, category, page: 1 })}>
          {loading && snapshot === null && <p role="status">{content.loading}</p>}
          {!loading && error === null && products.length === 0 && <p>{content.emptyCategoryProducts}</p>}
          <div className="shop-grid">
            {products.map((item) => <article className={`shop-card shop-product-card${item.owned ? ' shop-product-purchased' : ''}`} key={item.id}>
              <h3>{item.name}</h3>
              <ShopItemArtwork className="shop-item-art shop-product-art" item={item} />
              <div className="shop-product-footer">
                <button className="shop-product-buy" type="button"
                  disabled={item.owned || buyingAll || Boolean(pending) || error !== null || !currentWallet || !canBuy(item, currentWallet)}
                  onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}
                  aria-label={`${content.buy} ${item.name}`}
                  aria-description={[
                    `${content.coins} ${item.coin_price}`,
                    item.diamond_price > 0 ? `${content.diamonds} ${item.diamond_price}` : null,
                    item.owned ? content.owned : item.stock === 0 ? content.soldOut : currentWallet && !canBuy(item, currentWallet) ? content.insufficient : null,
                  ].filter(Boolean).join('，')}>
                  <span><img src="/api/v1/assets/coin-v1" alt={content.coins} /><strong>{item.coin_price}</strong></span>
                  {item.diamond_price > 0 && <span><img src="/api/v1/assets/gem-v1" alt={content.diamonds} /><strong>{item.diamond_price}</strong></span>}
                </button>
                {item.owned && <strong>{content.owned}</strong>}
              </div>
            </article>)}
          </div>
          <NumberedPagination page={currentPage} totalPages={totalPages} disabled={loading || error !== null}
            onPageChange={(page) => browse({ ...selection, page })} />
        </ViewTabs>
      </ViewTabs>
    </div>
    {selected && confirmationWallet && <PurchaseDialog client={client} product={selected} wallet={confirmationWallet}
      allowOwned={false} onClose={(offerChanged) => { setSelected(null); if (offerChanged) reload(); }} onPurchased={purchased} />}
  </div>;
}
