import { useState } from 'react';
import { ViewTabs } from '../../components/ViewTabs';
import { CatalogFilters } from './CatalogFilters';
import { ProductEditor } from './ProductEditor';
import { ShopMaterialLibrary } from './ShopMaterialLibrary';
import { ShopItemArtwork } from './ShopItemArtwork';
import { Price } from './Price';
import { pendingProducts } from './pending';
import { shopError } from './helpers';
import { shopCategoryTabs, shopGroups } from './shop-categories';
import type { ShopGroup } from './shop-categories';
import type { ManagementMaterial, Product, ShopProps } from './types';
import { useProductCatalog, type CatalogSearch } from './useProductCatalog';
import content from './content.json';
import './shop.css';

type CatalogSection = 'products' | 'materials';

const sections = [
  { id: 'products', label: content.productLibrary },
  { id: 'materials', label: content.materialLibrary },
] as const;
const emptySearch: CatalogSearch = { search: '', provider: '', packKey: '' };

// 管理目录与商店使用相同分类，另保留停用和已拥有的报价。
export function ProductManagement({ client, session }: ShopProps) {
  const [section, setSection] = useState<CatalogSection>('products');
  const [group, setGroup] = useState<ShopGroup>('appearance');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState(emptySearch);
  const [revision, refresh] = useState(0);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState<ManagementMaterial | 'recover' | null>(null);
  const catalog = useProductCatalog(client, { search, revision, group, category });
  const pending = pendingProducts.get(client);

  // 从素材新增后回到对应商品分类，确保上一个筛选条件不会遮住它。
  function savedProduct(product: Product) {
    if (creating) {
      if (creating === 'recover') {
        setGroup(product.type === 'scene' || product.type === 'island' ? 'camp' : 'appearance');
        setCategory('');
      } else {
        setGroup(creating.group);
        setCategory(creating.category);
      }
      setSearch(emptySearch);
    }
    setEditing(null);
    setCreating(null);
    setSection('products');
    setMessage(content.productSaved);
    refresh((value) => value + 1);
  }

  // 来源和素材包仅在各自分组中有效，搜索仍可跨组使用。
  function changeGroup(next: ShopGroup) {
    if (next === group) return;
    setGroup(next);
    setCategory('');
    setSearch((before) => ({ ...before, provider: '', packKey: '' }));
  }

  return <div className="shop-workspace shop-management">
    {message && <p role="status" className="shop-warning feedback-success">{message}</p>}
    {pending && !creating && <div className="shop-warning">
      <p>{content.createPending}</p>
      <button type="button" onClick={(event) => { event.currentTarget.focus(); setCreating('recover'); }}>{content.recoverCreate}</button>
    </div>}
    <ViewTabs label={content.manageTitle} items={sections} value={section} onChange={setSection}
      className="shop-category-tabs" panelClassName="shop-category-panel">
      {section === 'materials'
        ? <ShopMaterialLibrary client={client} initialGroup={group} initialCategory={category} createPending={Boolean(pending)} onCreate={setCreating} />
        : <div className="shop-categories">
          <ViewTabs label={content.categoryGroupLabel} className="shop-category-tabs" panelClassName="shop-category-panel"
            items={shopGroups} value={group} onChange={changeGroup}
            actions={<div className="shop-category-actions"><button type="button" disabled={Boolean(pending)} onClick={() => setSection('materials')}>{content.addProduct}</button></div>}>
            <ViewTabs label={group === 'appearance' ? content.categoryDetailLabel : content.campCategoryLabel}
              className="shop-category-tabs shop-category-details" items={shopCategoryTabs(group, catalog.campCategories)}
              value={category} onChange={setCategory}>
              <CatalogFilters value={search} facets={catalog.facets} onChange={setSearch} />
              {catalog.error !== null && <div role="alert">
                <p className="shop-error">{shopError(catalog.error)}</p>
                <button type="button" className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button>
              </div>}
              {catalog.loading && <p role="status">{content.loading}</p>}
              {!catalog.loading && catalog.error === null && catalog.products.length === 0 && <p>{content.emptyCategoryProducts}</p>}
              <div className="shop-grid shop-management-grid">
                {catalog.products.map((item) => <article key={item.id} className="shop-card shop-product-card shop-management-card">
                  <h3>{item.name}</h3>
                  <ShopItemArtwork item={item} className="shop-item-art shop-product-art" />
                  <Price coins={item.coin_price} diamonds={item.diamond_price} />
                  <p>{content.stock} {item.stock ?? content.unlimited} · <span>{item.enabled ? content.enabled : content.unavailable}</span></p>
                  <button type="button" className="secondary" aria-label={`${content.edit} ${item.name}`}
                    onClick={(event) => { event.currentTarget.focus(); setEditing(item); }}>{content.edit}</button>
                </article>)}
              </div>
              {catalog.cursor && <button type="button" className="secondary" disabled={catalog.loadingMore} onClick={() => void catalog.more()}>
                {catalog.loadingMore ? content.loading : content.more}
              </button>}
            </ViewTabs>
          </ViewTabs>
        </div>}
    </ViewTabs>
    {(editing || creating) && <ProductEditor client={client} session={session} product={editing}
      {...(creating && creating !== 'recover' ? { material: creating } : {})}
      onClose={() => { setEditing(null); setCreating(null); }} onSaved={savedProduct} />}
  </div>;
}
