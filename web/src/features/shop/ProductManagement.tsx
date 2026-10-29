import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import type { Asset, Product, ShopProps } from './types';
import { ProductEditor } from './ProductEditor';
import { Price } from './Price';
import { pendingProducts } from './pending';
import { shopError } from './helpers';
import content from './content.json';
import './shop.css';
import { categoryLabel, itemCategory } from './shop-categories';
import { ShopItemArtwork } from './ShopItemArtwork';

// 管理商品读取包括下架配置，删除只移除销售入口，历史所有权保留。
export function ProductManagement({ client, session }: ShopProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [revision, refresh] = useState(0);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const pending = pendingProducts.get(client);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      client.request<{ items: Product[] }>('/products?include_inactive=true', {
        signal: controller.signal,
      }),
      client.request<{ items: Asset[] }>('/assets', { signal: controller.signal }),
    ])
      .then(([productList, assetList]) => {
        if (!controller.signal.aborted) {
          setProducts(productList.items);
          setAssets(assetList.items);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, revision]);
  async function deleteProduct() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await client.request<void>(`/management/products/${deleting.id}`, {
        method: 'DELETE',
        body: { expected_version: deleting.version },
      });
      setDeleting(null);
      setMessage(content.productDeleted);
      refresh((value) => value + 1);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shop-workspace">
      <h1>{content.manageTitle}</h1>
      {message && (
        <p role="status" className="shop-warning">
          {message}
        </p>
      )}
      {pending && (
        <div className="shop-warning">
          <p>{content.createPending}</p>
          <button
            onClick={(event) => {
              event.currentTarget.focus();
              setEditing('new');
            }}
          >
            {content.recoverCreate}
          </button>
        </div>
      )}
      {error !== null && (
        <div role="alert">
          <p className="shop-error">{shopError(error)}</p>
          <button
            className="secondary"
            onClick={() => {
              setDeleting(null);
              refresh((value) => value + 1);
            }}
          >
            {content.reload}
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={loading || Boolean(pending)}
        onClick={(event) => {
          event.currentTarget.focus();
          setEditing('new');
        }}
      >
        {content.addProduct}
      </button>
      {loading ? (
        <p role="status">{content.loading}</p>
      ) : (
        <div className="shop-product-list">
          {products.length === 0 && <p>{content.emptyProducts}</p>}
          {products.map((item) => (
            <article key={item.id} className="shop-product-row">
              <ShopItemArtwork item={item} />
              <div>
                <h3>{item.name}</h3>
                <p>
                  {categoryLabel(itemCategory(item)!)}
                  {!item.enabled && <strong> · {content.unavailable}</strong>}
                </p>
                <Price coins={item.coin_price} diamonds={item.diamond_price} />
                <p>
                  {content.stock} {item.stock ?? content.unlimited}
                </p>
              </div>
              <div className="shop-actions">
                <button
                  className="secondary"
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setEditing(item);
                  }}
                  aria-label={`${content.edit} ${item.name}`}
                >
                  {content.edit}
                </button>
                <button
                  className="secondary"
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setError(null);
                    setDeleting(item);
                  }}
                  aria-label={`${content.delete} ${item.name}`}
                >
                  {content.delete}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing !== null && (
        <ProductEditor
          client={client}
          session={session}
          product={editing === 'new' ? null : editing}
          assets={assets}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMessage(content.productSaved);
            refresh((value) => value + 1);
          }}
        />
      )}
      {deleting && (
        <Modal title={content.deleteProduct} onClose={() => setDeleting(null)} closeDisabled={busy}>
          <h3>{deleting.name}</h3>
          <p>{content.deleteHint}</p>
          {error !== null && (
            <p role="alert" className="shop-error">
              {shopError(error)}
            </p>
          )}
          <div className="button-row">
            <button disabled={busy} onClick={() => void deleteProduct()}>
              {busy ? content.saving : content.confirmDelete}
            </button>
            <button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>
              {content.cancel}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
