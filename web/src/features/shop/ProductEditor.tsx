import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import { createIdempotencyKey } from '../../api/idempotency-key';
import { CurrencyIcon } from '../../components/CurrencyAmount';
import { FieldError } from '../../components/FormFeedback';
import { Modal } from '../../components/Modal';
import type { ManagementMaterial, Product, ProductInput, ShopProps } from './types';
import { pendingProducts } from './pending';
import { shopError, uncertainResult } from './helpers';
import { Price } from './Price';
import { ShopItemArtwork } from './ShopItemArtwork';
import { shopCategoryName } from './shop-categories';
import content from './content.json';

type ProductDraft = Omit<ProductInput, 'asset_key'>;

// 目录装扮编辑现有报价，营地新增时由素材库确定商品身份。
interface ProductEditorProps extends ShopProps {
  product: Product | null; // 有值时编辑既有报价。
  material?: ManagementMaterial; // 新建时已选的素材。恢复时从原命令读取素材。
  onClose: () => void; // 退出编辑。
  onSaved: (product: Product) => void; // 将保存后的商品交还目录。
}

// 新增未知结果重放原命令，编辑冲突先查看当前配置，再确认保留的草稿。
export function ProductEditor({ client, session, product, material, onClose, onSaved }: ProductEditorProps) {
  const original = product ? undefined : pendingProducts.get(client);
  const assetKey = product?.asset_key ?? original?.body.asset_key ?? material?.asset.key;
  const [initial] = useState<ProductDraft>(() => ({
    name: original?.body.name ?? product?.name ?? material?.asset.name ?? '',
    coin_price: original?.body.coin_price ?? product?.coin_price ?? 0,
    diamond_price: original?.body.diamond_price ?? product?.diamond_price ?? 0,
    stock: original?.body.stock ?? product?.stock ?? null,
    enabled: original?.body.enabled ?? product?.enabled ?? true,
  }));
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(original ?? null);
  const [version, setVersion] = useState(product?.version ?? 0);
  const [latest, setLatest] = useState<Product | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [discarding, setDiscarding] = useState(false);

  function update(change: Partial<ProductDraft>) {
    setDraft((value) => ({ ...value, ...change }));
  }

  function close() {
    if (busy) return;
    if (!pending && JSON.stringify(initial) !== JSON.stringify(draft)) {
      setDiscarding(true);
      return;
    }
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || needsRefresh || !assetKey) return;
    setBusy(true);
    setError(null);
    try {
      let result: Product;
      if (product) {
        result = await client.request<Product>(`/management/products/${product.id}`, {
          method: 'PATCH',
          body: { ...draft, expected_version: version },
        });
      } else {
        const command = pending ?? { key: createIdempotencyKey(), body: Object.freeze({ ...draft, asset_key: assetKey }) };
        setPending(command);
        pendingProducts.set(client, command);
        result = await client.request<Product>('/management/products', {
          method: 'POST',
          body: command.body,
          idempotencyKey: command.key,
        });
        pendingProducts.delete(client);
        setPending(null);
      }
      onSaved(result);
    } catch (reason) {
      setError(reason);
      if (!product && !uncertainResult(reason)) {
        pendingProducts.delete(client);
        setPending(null);
      }
      if (product && reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT') {
        setNeedsRefresh(true);
        setLatest(null);
      }
    } finally {
      setBusy(false);
    }
  }

  // 更新版本并展示当前报价，保留用户的草稿。
  async function reloadProduct() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.request<{ items: Product[] }>('/products?include_inactive=true');
      const current = result.items.find((item) => item.id === product.id);
      if (!current) throw new ApiFailure(409, { code: 'PRODUCT_UNAVAILABLE', field_errors: {}, request_id: '' });
      setVersion(current.version);
      setLatest(current);
      setNeedsRefresh(false);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  if (discarding) return <Modal title={content.discardChanges} onClose={() => setDiscarding(false)}>
    <div className="button-row">
      <button onClick={() => setDiscarding(false)}>{content.keepEditing}</button>
      <button className="secondary" onClick={onClose}>{content.discard}</button>
    </div>
  </Modal>;

  return <Modal title={product ? content.editProduct : content.addProduct} onClose={close} closeDisabled={busy}>
    <form className="shop-editor" onSubmit={submit}>
      {assetKey && <div className="shop-editor-binding">
        <ShopItemArtwork item={{ asset_key: assetKey }} label={content.asset} />
        <div>
          <strong>{material?.asset.name ?? content.asset}</strong>
          {material && <p>{shopCategoryName(material.group, material.category)}</p>}
          <code>{assetKey}</code>
        </div>
      </div>}
      <fieldset className="shop-fieldset shop-editor-fields" disabled={busy || Boolean(pending)}>
        <div className="shop-editor-field shop-editor-field-wide">
          <label htmlFor="product-name">{content.name}</label>
          <input id="product-name" value={draft.name} required onChange={(event) => update({ name: event.target.value })} />
          <FieldError error={error} field="name" />
        </div>
        <div className="shop-editor-field">
          <label htmlFor="product-coins"><CurrencyIcon currency="coins" label={content.coinPrice} /></label>
          <input id="product-coins" aria-label={content.coinPrice} type="number" min={0} max={session.limits.price_max}
            step={1} value={draft.coin_price} required onChange={(event) => update({ coin_price: Number(event.target.value) })} />
          <FieldError error={error} field="coin_price" />
        </div>
        <div className="shop-editor-field">
          <label htmlFor="product-diamonds"><CurrencyIcon currency="diamonds" label={content.diamondPrice} /></label>
          <input id="product-diamonds" aria-label={content.diamondPrice} type="number" min={0} max={session.limits.price_max}
            step={1} value={draft.diamond_price} required onChange={(event) => update({ diamond_price: Number(event.target.value) })} />
          <FieldError error={error} field="diamond_price" />
        </div>
        <label className="shop-form-check">
          <input type="checkbox" checked={draft.stock === null} onChange={(event) => update({ stock: event.target.checked ? null : 0 })} />
          {content.unlimitedStock}
        </label>
        <label className="shop-form-check">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          {content.enabled}
        </label>
        {draft.stock !== null && <div className="shop-editor-field">
          <label htmlFor="product-stock">{content.finiteStock}</label>
          <input id="product-stock" type="number" min={0} max={session.limits.stock_max} step={1} required
            value={draft.stock} onChange={(event) => update({ stock: Number(event.target.value) })} />
          <FieldError error={error} field="stock" />
        </div>}
        {!product && <FieldError error={error} field="asset_key" />}
      </fieldset>
      {pending && !busy && <p className="shop-warning">{content.createPending}</p>}
      {error !== null && <p className="shop-error" role="alert">{shopError(error)}</p>}
      {needsRefresh && <button type="button" disabled={busy} onClick={() => void reloadProduct()}>{content.reloadProduct}</button>}
      {latest && <div className="shop-warning">
        <p>{content.currentProduct} <strong>{latest.name}</strong></p>
        <Price coins={latest.coin_price} diamonds={latest.diamond_price} />
        <p>{content.stock} {latest.stock ?? content.unlimited} · {latest.enabled ? content.enabled : content.unavailable}</p>
        <p>{content.reviewProduct}</p>
      </div>}
      <button type="submit" disabled={busy || needsRefresh || !assetKey}>
        {busy ? content.saving : pending ? content.recoverCreate : latest ? content.confirmDraft : content.save}
      </button>
    </form>
  </Modal>;
}
