import type { Product, ProductInput, PurchaseInput, ShopClient, Wallet } from './types';

// 未确认购买同时保留原命令和用户当时核对的价格、余额。
export interface PendingPurchase {
  key: string; // 原幂等键，只有明确失败并重新确认后才更换。
  body: Readonly<PurchaseInput>; // 原请求，不能用刷新后的版本替换。
  product: Product; // 原价格快照。
  wallet: Wallet; // 原余额快照。
}

// 新增商品也可能成功但丢失响应；跨页面保留原请求用于恢复。
export interface PendingProduct {
  key: string; // 原新增键。
  body: Readonly<ProductInput>; // 原表单快照。
}

export const pendingPurchases = new WeakMap<ShopClient, PendingPurchase>();
export const pendingProducts = new WeakMap<ShopClient, PendingProduct>();
