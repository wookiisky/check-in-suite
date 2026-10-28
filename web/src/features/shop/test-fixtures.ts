import type { Camp, Equipment, Product, Purchase, Wallet } from './types';
import { testSession } from '../../test/account-fixtures';

// 商店组件协议夹具与正式数据分离。
export const wallet: Wallet = { coins: 100, diamonds: 20, version: 1 };
export const product: Product = {
  id: 'product-1',
  type: 'accessory',
  name: '星星饰品',
  asset_key: 'accessory-star-v1',
  description: '陪你成长',
  coin_price: 10,
  diamond_price: 2,
  stock: 3,
  enabled: true,
  version: 1,
  owned: false,
};
export const purchase: Purchase = {
  id: 'purchase-1',
  product_id: product.id,
  type_snapshot: product.type,
  name_snapshot: product.name,
  asset_key_snapshot: product.asset_key,
  description_snapshot: product.description,
  coin_price: 10,
  diamond_price: 2,
  status: 'owned',
  redeemed_at: null,
  version: 1,
  created_at: '2026-10-29T00:00:00Z',
};
export const equipment: Equipment = { title: null, avatar: null, accessories: [] };
export const camp: Camp = {
  today: testSession.today,
  server_now: testSession.server_now,
  timezone: 'Asia/Taipei',
  tasks: [],
  categories: [],
  wallet,
  account: testSession.account,
  has_scheduled_tasks: false,
  equipment,
};
