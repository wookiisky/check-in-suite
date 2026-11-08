import type { Asset, Product, Purchase } from './types';
import { assetURL } from './helpers';

// 服装直接展示模型生成的缩略图，不在商品卡片启动三维渲染。
export function ShopItemArtwork({ item, className = 'shop-item-art', label }: {
  item: Pick<Product, 'asset_key'> | Pick<Purchase, 'asset_key_snapshot'> | Pick<Asset, 'key'>;
  className?: string;
  label?: string;
}) {
  const key = 'asset_key_snapshot' in item ? item.asset_key_snapshot : 'asset_key' in item ? item.asset_key : item.key;
  return <img className={className} src={assetURL(key)} alt={label ?? ''} loading="lazy" decoding="async" />;
}
