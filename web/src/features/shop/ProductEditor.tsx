import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Asset, CharacterDefinition, CharacterWearable, Product, ProductInput, SceneOption, ShopProps } from './types';
import { pendingProducts } from './pending';
import { shopError, uncertainResult } from './helpers';
import { Price } from './Price';
import { createIdempotencyKey } from '../../api/idempotency-key';
import content from './content.json';
import { CurrencyIcon } from '../../components/CurrencyAmount';
import { categoryLabel, categoryPurchaseType, isWearableSlot, matchesAssetCategory, shopCategories } from './shop-categories';
import type { ShopCategory } from './shop-categories';
import { ShopItemArtwork } from './ShopItemArtwork';

// 商品表单只提交可编辑字段，不将id、owned等只读属性回传。
function draftFor(product: Product | null, assets: Asset[]): ProductInput {
  return product
    ? {
        type: product.type,
        name: product.name,
        asset_key: product.asset_key,
        ...(product.wearable_key ? { wearable_key: product.wearable_key } : {}),
        ...(product.character_key ? { character_key: product.character_key } : {}),
        ...(product.scene_key ? { scene_key: product.scene_key } : {}),
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
  characters = [],
  wearables = [],
  onClose,
  onSaved,
}: ShopProps & {
  product: Product | null;
  assets: Asset[];
  characters?: readonly CharacterDefinition[]; // 默认服装来自身体定义，不进入商品选择。
  wearables?: readonly CharacterWearable[]; // 部位和稳定身份均由目录定义。
  onClose: () => void;
  onSaved: (product: Product) => void;
}) {
  const original = product ? undefined : pendingProducts.get(client);
  const [initial] = useState(() => original?.body ?? draftFor(product, assets));
  const [draft, setDraft] = useState<ProductInput>(initial);
  const [category, setCategory] = useState<ShopCategory>(() => initial.type === 'wearable'
    ? wearables.find((item) => item.wearable_key === initial.wearable_key)?.slot ?? 'head'
    : initial.type as ShopCategory);
  const [pending, setPending] = useState(original ?? null);
  const [version, setVersion] = useState(product?.version ?? 0);
  const [latest, setLatest] = useState<Product | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [discarding, setDiscarding] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetLimit, setAssetLimit] = useState(100);
  const [scenes, setScenes] = useState<SceneOption[]>([]);
  const [sceneLoading, setSceneLoading] = useState(initial.type === 'scene');
  const [sceneError, setSceneError] = useState<unknown>(null);
  const [sceneRevision, reloadScenes] = useState(0);
  // 场景商品必须选目录中的稳定空间，不能用任意图片推导解锁身份。
  useEffect(() => {
    if (category !== 'scene') return;
    const controller = new AbortController();
    setSceneLoading(true);
    setSceneError(null);
    void client.request<{ items: SceneOption[] }>('/island/scenes', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setScenes(result.items.filter((scene) => !scene.free)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setSceneError(reason); })
      .finally(() => { if (!controller.signal.aborted) setSceneLoading(false); });
    return () => controller.abort();
  }, [client, category, sceneRevision]);
  const selectedAsset = assets.find((item) => item.key === draft.asset_key);
  const identityLocked = (product?.owned_count ?? 0) > 0; // 服务端仍会复核其他账户的历史购买。
  const searchTerm = assetSearch.trim().toLocaleLowerCase();
  const names = new Map([...wearables.map((item) => [item.thumbnail_asset_key, item.name] as const), ...characters.map((item) => [item.thumbnail_asset_key, item.name] as const), ...scenes.map((item) => [item.thumbnail_asset_key, item.name] as const)]);
  const choices = assets.filter((item) => matchesAssetCategory(item, category, wearables, characters, scenes) && (!searchTerm || `${names.get(item.key) ?? item.name} ${item.provider ?? ''} ${item.pack_name ?? item.pack_key ?? ''}`.toLocaleLowerCase().includes(searchTerm)));
  const visibleChoices = choices.slice(0, assetLimit);
  if (selectedAsset && (identityLocked || matchesAssetCategory(selectedAsset, category, wearables, characters, scenes)) && !visibleChoices.some((item) => item.key === selectedAsset.key)) visibleChoices.unshift(selectedAsset);
  // 同时修改素材与稳定身份，防止类型切换后带入上一次服装的 key。
  function selectAsset(assetKey: string, nextCategory: ShopCategory) {
    const definition = isWearableSlot(nextCategory)
      ? wearables.find((item) => item.thumbnail_asset_key === assetKey && item.slot === nextCategory)
      : undefined;
    const selectedCharacter = nextCategory === 'character' ? characters.find((item) => item.thumbnail_asset_key === assetKey) : undefined;
    const selectedScene = nextCategory === 'scene' ? scenes.find((item) => item.thumbnail_asset_key === assetKey) : undefined;
    setDraft(({ wearable_key: _previousKey, character_key: _previousCharacter, scene_key: _previousScene, ...value }) => ({
      ...value,
      type: categoryPurchaseType(nextCategory) as ProductInput['type'],
      asset_key: assetKey,
      ...(definition ? { wearable_key: definition.wearable_key } : {}),
      ...(selectedCharacter ? { character_key: selectedCharacter.character_key } : {}),
      ...(selectedScene ? { scene_key: selectedScene.scene_key } : {}),
    }));
  }

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
        const command = pending ?? { key: createIdempotencyKey(), body: Object.freeze({ ...draft }) };
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
            value={category}
            disabled={identityLocked}
            onChange={(event) => {
              const next = event.target.value as ShopCategory;
              setCategory(next);
              setAssetSearch(''); setAssetLimit(100);
              selectAsset(assets.find((item) => matchesAssetCategory(item, next, wearables, characters, scenes))?.key ?? '', next);
            }}
          >
            {shopCategories.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
          </select>
          <label htmlFor="product-asset-search">{content.assetSearchLabel}</label>
          <input id="product-asset-search" type="search" value={assetSearch} disabled={identityLocked} onChange={(event) => { setAssetSearch(event.target.value); setAssetLimit(100); }} />
          <label htmlFor="product-asset">{content.asset}</label>
          <select
            id="product-asset"
            value={draft.asset_key}
            required
            disabled={identityLocked || category === 'scene' && sceneLoading}
            onChange={(event) => selectAsset(event.target.value, category)}
          >
            <option value="">{content.chooseAsset}</option>
            {visibleChoices.map((item) => (
                <option key={item.key} value={item.key}>
                  {names.get(item.key) ?? item.name}
                </option>
              ))}
          </select>
          {category === 'scene' && sceneLoading && <p role="status">{content.sceneCatalogLoading}</p>}
          {category === 'scene' && sceneError !== null && <div role="alert"><p className="shop-error">{shopError(sceneError)}</p><button type="button" onClick={() => reloadScenes((value) => value + 1)}>{content.sceneCatalogRetry}</button></div>}
          {choices.length > assetLimit && <button type="button" className="secondary" onClick={() => setAssetLimit((value) => value + 100)}>{content.moreAssets}</button>}
          <FieldError error={error} field="asset_key" />
          <FieldError error={error} field="wearable_key" />
          <FieldError error={error} field="character_key" />
          <FieldError error={error} field="scene_key" />
          {selectedAsset && <ShopItemArtwork item={selectedAsset} />}
          <label htmlFor="product-description">{content.description}</label>
          <textarea
            id="product-description"
            rows={3}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
          <FieldError error={error} field="description" />
          <label htmlFor="product-coins"><CurrencyIcon currency="coins" label={content.coinPrice} /></label>
          <input
            id="product-coins"
            aria-label={content.coinPrice}
            type="number"
            min={0}
            max={session.limits.price_max}
            step={1}
            value={draft.coin_price}
            required
            onChange={(event) => update({ coin_price: Number(event.target.value) })}
          />
          <FieldError error={error} field="coin_price" />
          <label htmlFor="product-diamonds"><CurrencyIcon currency="diamonds" label={content.diamondPrice} /></label>
          <input
            id="product-diamonds"
            aria-label={content.diamondPrice}
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
        <button type="submit" disabled={busy || needsRefresh || category === 'scene' && !pending && (sceneLoading || sceneError !== null)}>
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
