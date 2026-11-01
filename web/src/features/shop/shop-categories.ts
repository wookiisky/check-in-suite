import type { Asset, CharacterDefinition, CharacterSlot, CharacterWearable, Product, Purchase, SceneOption } from './types';
import content from './content.json';

export type ShopCategory = CharacterSlot | 'character' | 'title' | 'reward' | 'island' | 'scene';

// 商品用途由正式类型及服装定义决定，不从名称或素材key推测。
export const wardrobeCategories: ShopCategory[] = ['character', 'hair', 'upper', 'lower', 'shoes', 'title'];
export const shopCategories: ShopCategory[] = [...wardrobeCategories, 'reward', 'island', 'scene'];

// 四个槽位共用人物目录的稳定类型。
export function isWearableSlot(value: string): value is CharacterSlot {
  return Object.hasOwn(content.wearableSlots, value);
}

// 用户可见分类名集中维护，交易类型仍保留在商品中。
export function categoryLabel(category: ShopCategory): string {
  return isWearableSlot(category) ? content.wearableSlots[category] : content.types[category];
}

// 定义缺失的服装不猜测部位，等待目录读取或报告读取失败。
export function itemCategory(item: Product | Purchase, wearables: readonly CharacterWearable[] = []): ShopCategory | null {
  const type = 'type_snapshot' in item ? item.type_snapshot : item.type;
  return type === 'wearable' ? wearables.find((definition) => definition.wearable_key === item.wearable_key)?.slot ?? null : type;
}

// 默认服装来自身体定义，不依靠缩略图的免费标志。
export function matchesAssetCategory(asset: Asset, category: ShopCategory, wearables: readonly CharacterWearable[] = [], characters: readonly CharacterDefinition[] = [], scenes: readonly SceneOption[] = []): boolean {
  if (category === 'scene') return scenes.some((scene) => !scene.free && scene.thumbnail_asset_key === asset.key);
  if (!isWearableSlot(category)) return asset.kind === category && !asset.free;
  const defaults = new Set(characters.flatMap((character) => Object.values(character.defaults)));
  return wearables.some((definition) => definition.slot === category && definition.thumbnail_asset_key === asset.key && !defaults.has(definition.wearable_key));
}

// 槽位过滤读取服装订单，分页后仍按定义筛选。
export function categoryPurchaseType(category: ShopCategory): string {
  return isWearableSlot(category) ? 'wearable' : category;
}

// 分类属于页面本地状态，保存外观不会重置筛选或分页。
export interface CategoryFilter {
  group: 'all' | 'appearance' | 'island' | 'scene' | 'reward'; // 一级用途。
  category: ShopCategory | ''; // 角色装扮的具体部位或称号。
}

// 三维服装、营地物品和奖励各自使用明确的交易类型。
export function matchesCategory(item: Product | Purchase, filter: CategoryFilter, wearables: readonly CharacterWearable[] = []): boolean {
  if (filter.group === 'all') return true;
  const type = 'type_snapshot' in item ? item.type_snapshot : item.type;
  if (filter.group === 'island' || filter.group === 'scene' || filter.group === 'reward') return type === filter.group;
  if (type !== 'character' && type !== 'title' && type !== 'wearable') return false;
  return !filter.category || itemCategory(item, wearables) === filter.category;
}
