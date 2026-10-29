import type { Asset, Product, Purchase } from './types';
import { assetURL, portraitAssetKey, portraitType } from './helpers';
import preview from './wearable-preview.json';

// 穿戴缩略图裁切对应身体部位；实际穿戴仍使用完整坐标，前后头发同时展示。
export function ShopItemArtwork({ item, className = 'shop-item-art', label }: {
  item: Product | Purchase | Asset;
  className?: string;
  label?: string;
}) {
  const key = 'asset_key_snapshot' in item ? portraitAssetKey(item) : 'asset_key' in item ? item.asset_key : item.key;
  const kind = 'type_snapshot' in item ? portraitType(item) : 'type' in item ? item.type : item.kind;
  if (!item.wearable_slot) return <img className={className} src={assetURL(key, kind === 'effect')} alt={label ?? ''} />;
  return <svg className={className} viewBox={preview[item.wearable_slot]} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {item.back_asset_key && <image href={assetURL(item.back_asset_key)} width="320" height="320" />}
    <image href={assetURL(key)} width="320" height="320" />
  </svg>;
}
