import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Asset, Product, ProductInput, ShopProps } from './types';
import { pendingProducts } from './pending';
import { assetURL, shopError, uncertainResult } from './helpers';
import { Price } from './Price';
import content from './content.json';

// 商品表单只提交可编辑字段，不将id、owned等只读属性回传。
function draftFor(product: Product | null, assets: Asset[]): ProductInput {
  return product
    ? {
        type: product.type,
        name: product.name,
        asset_key: product.asset_key,
        description: product.description,
        coin_price: product.coin_price,
        diamond_price: product.diamond_price,
        stock: product.stock,
        enabled: product.enabled,
      }
    : {
        type: 'title',
        name: '',
        asset_key: assets.find((item) => item.kind === 'title')?.key ?? '',
        description: '',
        coin_price: 0,
        diamond_price: 0,
        stock: null,
        enabled: true,
      };
}

// 新增未知结果重放原命令；编辑冲突先查看当前配置，再确认保留的草稿。
export function ProductEditor({
  client,
  session,
  product,
  assets,
  onClose,
  onSaved,
}: ShopProps & {
  product: Product | null;
  assets: Asset[];
  onClose: () => void;
  onSaved: (product: Product) => void;
}) {
  const original = product ? undefined : pendingProducts.get(client);
  const [initial] = useState(() => original?.body ?? draftFor(product, assets));
  const [draft, setDraft] = useState<ProductInput>(initial);
  const [pending, setPending] = useState(original ?? null);
  const [version, setVersion] = useState(product?.version ?? 0);
  const [latest, setLatest] = useState<Product | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [discarding, setDiscarding] = useState(false);
  function update(change: Partial<ProductInput>) {
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
    if (needsRefresh) return;
    setBusy(true);
    setError(null);
    try {
      let result: Product;
      if (product)
        result = await client.request<Product>(`/management/products/${product.id}`, {
          method: 'PATCH',
          body: { ...draft, expected_version: version },
        });
      else {
        const command = pending ?? { key: crypto.randomUUID(), body: Object.freeze({ ...draft }) };
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
      if (reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT') {
        setNeedsRefresh(true);
        setLatest(null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function reloadProduct() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.request<{ items: Product[] }>('/products?include_inactive=true');
      const current = result.items.find((item) => item.id === product.id);
      if (!current)
        throw new ApiFailure(409, {
          code: 'PRODUCT_UNAVAILABLE',
          field_errors: {},
          request_id: '',
        });
      setVersion(current.version);
      setLatest(current);
      setNeedsRefresh(false);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  if (discarding)
    return (
      <Modal title={content.discardChanges} onClose={() => setDiscarding(false)}>
        <div className="button-row">
          <button onClick={() => setDiscarding(false)}>{content.keepEditing}</button>
          <button className="secondary" onClick={onClose}>
            {content.discard}
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={product ? content.editProduct : content.addProduct}
      onClose={close}
      closeDisabled={busy}
    >
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="shop-fieldset form-stack" disabled={busy || Boolean(pending)}>
          <label htmlFor="product-name">{content.name}</label>
          <input
            id="product-name"
            value={draft.name}
            required
            onChange={(event) => update({ name: event.target.value })}
          />
          <FieldError error={error} field="name" />
          <label htmlFor="product-type">{content.typeFilter}</label>
          <select
            id="product-type"
            value={draft.type}
            onChange={(event) => {
              const next = event.target.value as ProductInput['type'];
              update({
                type: next,
                asset_key: assets.find((item) => item.kind === next)?.key ?? '',
              });
            }}
          >
            {Object.entries(content.types).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="product-asset">{content.asset}</label>
          <select
            id="product-asset"
            value={draft.asset_key}
            required
            onChange={(event) => update({ asset_key: event.target.value })}
          >
            <option value="">{content.chooseAsset}</option>
            {assets
              .filter((item) => item.kind === draft.type)
              .map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
          </select>
          <FieldError error={error} field="asset_key" />
          {draft.asset_key && (
            <img className="shop-item-art" src={assetURL(draft.asset_key)} alt="" />
          )}
          <label htmlFor="product-description">{content.description}</label>
          <textarea
            id="product-description"
            rows={3}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
          <FieldError error={error} field="description" />
          <label htmlFor="product-coins">{content.coinPrice}</label>
          <input
            id="product-coins"
            type="number"
            min={0}
            max={session.limits.price_max}
            step={1}
            value={draft.coin_price}
            required
            onChange={(event) => update({ coin_price: Number(event.target.value) })}
          />
          <FieldError error={error} field="coin_price" />
          <label htmlFor="product-diamonds">{content.diamondPrice}</label>
          <input
            id="product-diamonds"
            type="number"
            min={0}
            max={session.limits.price_max}
            step={1}
            value={draft.diamond_price}
            required
            onChange={(event) => update({ diamond_price: Number(event.target.value) })}
          />
          <FieldError error={error} field="diamond_price" />
          <label className="shop-form-check">
            <input
              type="checkbox"
              checked={draft.stock === null}
              onChange={(event) => update({ stock: event.target.checked ? null : 0 })}
            />
            {content.unlimitedStock}
          </label>
          {draft.stock !== null && (
            <>
              <label htmlFor="product-stock">{content.finiteStock}</label>
              <input
                id="product-stock"
                type="number"
                min={0}
                max={session.limits.stock_max}
                step={1}
                required
                value={draft.stock}
                onChange={(event) => update({ stock: Number(event.target.value) })}
              />
              <FieldError error={error} field="stock" />
            </>
          )}
          <label className="shop-form-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {content.enabled}
          </label>
        </fieldset>
        {pending && !busy && <p className="shop-warning">{content.createPending}</p>}
        {error !== null && (
          <p className="shop-error" role="alert">
            {shopError(error)}
          </p>
        )}
        {needsRefresh && (
          <button type="button" disabled={busy} onClick={() => void reloadProduct()}>
            {content.reloadProduct}
          </button>
        )}
        {latest && (
          <div className="shop-warning">
            <p>
              {content.currentProduct} <strong>{latest.name}</strong>
            </p>
            <Price coins={latest.coin_price} diamonds={latest.diamond_price} />
            <p>
              {content.stock} {latest.stock ?? content.unlimited}
            </p>
            <p>{content.reviewProduct}</p>
          </div>
        )}
        <button type="submit" disabled={busy || needsRefresh}>
          {busy
            ? content.saving
            : pending
              ? content.recoverCreate
              : latest
                ? content.confirmDraft
                : content.save}
        </button>
      </form>
    </Modal>
  );
}
