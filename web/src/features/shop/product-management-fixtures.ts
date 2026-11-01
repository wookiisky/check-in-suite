import type { components } from '../../api/schema';
import type { Asset, Product } from './types';
import { appearanceFixture } from './appearance-test-fixtures';

// 商品表单使用完整目录；名称与缩略图身份刻意不含部位语义。
export const productCatalog = appearanceFixture();
productCatalog.wearables.push({
  ...productCatalog.wearables[3]!,
  wearable_key: 'catalog-choice-z', name: '森林款', slot: 'upper',
  thumbnail_asset_key: 'catalog-preview-q', thumbnail_url: '/catalog-preview-q.png',
});
export const productAssets: Asset[] = [
  { key: 'title-crown-v1', name: '皇冠', kind: 'title', url: '/api/v1/assets/title-crown-v1' },
  { key: 'reward-book-v1', name: '阅读奖励', kind: 'reward', url: '/api/v1/assets/reward-book-v1' },
  ...productCatalog.wearables.map((item) => ({ key: item.thumbnail_asset_key, name: item.name, kind: 'wearable' as const, url: item.thumbnail_url })),
];
export const managedTitle: Product = {
  id: 'managed-title', type: 'title', name: '称号商品', asset_key: 'title-crown-v1', description: '',
  coin_price: 10, diamond_price: 2, stock: 3, enabled: true, version: 1, owned: false, owned_count: 0,
};
export const managedWearable: Product = {
  ...managedTitle, id: 'managed-wearable', type: 'wearable', name: '森林服装',
  asset_key: 'catalog-preview-q', wearable_key: 'catalog-choice-z',
};
export type ProductCatalog = Pick<components['schemas']['AppearanceState'], 'characters' | 'wearables'>;
