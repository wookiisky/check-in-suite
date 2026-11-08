import type { Asset, CharacterDefinition, CharacterSlot, CharacterWearable, Product, SceneOption } from './types';
import content from './content.json';

export type ShopCategory = CharacterSlot | 'character' | 'title' | 'reward' | 'island' | 'scene';

// 商品用途由正式类型及服装定义决定，不从名称或素材key推测。
export const appearanceCategories: ShopCategory[] = ['character', 'face', 'head', 'upper', 'lower', 'shoes', 'back'];
export const shopCategories: ShopCategory[] = [...appearanceCategories, 'title', 'reward', 'island', 'scene'];

// 六个槽位共用人物目录的稳定类型。
export function isWearableSlot(value: string): value is CharacterSlot {
  return Object.hasOwn(content.wearableSlots, value);
}

// 用户可见分类名集中维护，交易类型仍保留在商品中。
export function categoryLabel(category: ShopCategory): string {
  return isWearableSlot(category) ? content.wearableSlots[category] : content.types[category];
}

// 定义缺失的服装不猜测部位，等待目录读取或报告读取失败。
export function itemCategory(item: Product, wearables: readonly CharacterWearable[] = []): ShopCategory | null {
  return item.type === 'wearable' ? wearables.find((definition) => definition.wearable_key === item.wearable_key)?.slot ?? null : item.type;
}

// 默认服装来自身体定义，不依靠缩略图的免费标志。
export function matchesAssetCategory(asset: Asset, category: ShopCategory, wearables: readonly CharacterWearable[] = [], characters: readonly CharacterDefinition[] = [], scenes: readonly SceneOption[] = []): boolean {
  if (category === 'scene') return scenes.some((scene) => !scene.free && scene.thumbnail_asset_key === asset.key);
  if (category === 'character') return asset.kind === 'character' && !asset.free && characters.some((character) => character.thumbnail_asset_key === asset.key);
  if (!isWearableSlot(category)) return asset.kind === category && !asset.free;
  const defaults = new Set(characters.flatMap((character) => Object.values(character.defaults)));
  return wearables.some((definition) => definition.slot === category && definition.thumbnail_asset_key === asset.key && !defaults.has(definition.wearable_key));
}

// 所有穿戴槽位共用服装交易类型。
export function categoryPurchaseType(category: ShopCategory): string {
  return isWearableSlot(category) ? 'wearable' : category;
}
