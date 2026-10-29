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
export const equipment: Equipment = { base_avatar_key: 'avatar-boy-v2', wearables: { hair: null, top: null, bottom: null, shoes: null }, title: null, avatar: null, accessories: [], background: null, effects: [], accessory_layouts: {} };
// 满额装备的测试数据同时包含每件饰品的服务端布局。
export const fullEquipment: Equipment = {
  ...equipment,
  accessories: Array.from({ length: 10 }, (_, index) => ({ ...purchase, id: `p${index}`, name_snapshot: `饰品${index}` })),
  accessory_layouts: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `p${index}`, { x: ((index % 5) + 0.5) / 5, y: index < 5 ? 0.12 : 0.88, size: 0.18, layer: index + 1 },
  ])),
};
// 编辑夹具覆盖角色前后的两个饰品及固定背景、特效。
export const outfit: Equipment = {
  ...equipment,
  accessories: [purchase, { ...purchase, id: 'second', name_snapshot: '帽子' }],
  accessory_layouts: {
    [purchase.id]: { x: 0.5, y: 0.5, size: 0.2, layer: 1 },
    second: { x: 0.2, y: 0.3, size: 0.15, layer: 2 },
  },
  background: { ...purchase, id: 'bg', type_snapshot: 'background', name_snapshot: '草地', asset_key_snapshot: 'background-meadow-v1' },
  effects: [{ ...purchase, id: 'snow', type_snapshot: 'effect', name_snapshot: '下雪', asset_key_snapshot: 'effect-snow-v1' }],
};
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
  achievements: [],
};
