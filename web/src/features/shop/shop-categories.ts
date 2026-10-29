import type { Asset, Product, Purchase } from './types';
import { portraitType } from './helpers';
import content from './content.json';

export type WearableSlot = NonNullable<Purchase['wearable_slot']>;
export type ShopCategory = Product['type'] | WearableSlot;

// 穿戴部位只影响显示分类，成交和订单查询仍使用饰品类型。
export const wardrobeCategories: ShopCategory[] = ['hair', 'top', 'bottom', 'shoes', 'accessory', 'avatar', 'title', 'background', 'effect'];
export const shopCategories: ShopCategory[] = [...wardrobeCategories, 'reward', 'island'];

// 明确的部位定义避免从名称或素材命名猜测商品用途。
export function isWearableSlot(value: string): value is WearableSlot {
  return Object.hasOwn(content.wearableSlots, value);
}

// 单独的显示分类使普通饰品与固定穿戴可独立筛选。
export function categoryLabel(category: ShopCategory): string {
  return isWearableSlot(category) ? content.wearableSlots[category] : content.types[category];
}

// 保留交易类型，穿戴商品只在展示时归入对应部位。
export function itemCategory(item: Product | Purchase, portrait = false): ShopCategory | null {
  if (item.wearable_slot) return item.wearable_slot;
  return portrait ? portraitType(item) : 'type_snapshot' in item ? item.type_snapshot : item.type;
}

// 免费人物和内部图层不进入售卖素材，穿戴素材按部位筛选。
export function matchesAssetCategory(asset: Asset, category: ShopCategory): boolean {
  if (asset.free) return false;
  return isWearableSlot(category) ? asset.wearable_slot === category : asset.kind === category && !asset.wearable_slot;
}

// 筛选部位时仍查询饰品订单，后续页由页面保留并继续加载。
export function categoryPurchaseType(category: string): string {
  return isWearableSlot(category) ? 'accessory' : category;
}
