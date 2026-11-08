import type { CharacterSlot } from './types';
import content from './content.json';

export type ShopGroup = 'appearance' | 'camp';

export const shopGroups = [
  { id: 'appearance', label: content.categoryGroups.appearance },
  { id: 'camp', label: content.shopCamp },
] as const;

const appearanceCategories: readonly ('character' | CharacterSlot)[] = ['character', 'face', 'head', 'upper', 'lower', 'shoes', 'back'];

// 商店、管理商品与素材库共用分类文案，保留未预置的目录分类名称。
export function shopCategoryName(group: ShopGroup, category: string) {
  if (group === 'camp') return (content.campCategories as Readonly<Record<string, string>>)[category] ?? category;
  if (category === 'character') return content.types.character;
  return (content.wearableSlots as Readonly<Record<string, string>>)[category] ?? category;
}

// 装扮部位固定，营地分类由完整目录提供。
export function shopCategoryTabs(group: ShopGroup, campCategories: readonly string[]) {
  return [
    { id: '', label: content.categoryGroups.all },
    ...(group === 'appearance' ? appearanceCategories : campCategories).map((id) => ({ id, label: shopCategoryName(group, id) })),
  ];
}
