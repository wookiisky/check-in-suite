import { describe, expect, it } from 'vitest';
import { shopCategoryTabs } from './shop-categories';
import content from './content.json';

describe('商店目录分类', () => {
  it('装扮按固定部位展示，营地按目录提供的分类展示', () => {
    expect(shopCategoryTabs('appearance', ['furniture']).map((tab) => tab.id))
      .toEqual(['', 'character', 'face', 'head', 'upper', 'lower', 'shoes', 'back']);
    expect(shopCategoryTabs('camp', ['scene', 'furniture', 'custom'])).toEqual([
      { id: '', label: content.categoryGroups.all },
      { id: 'scene', label: content.campCategories.scene },
      { id: 'furniture', label: content.campCategories.furniture },
      { id: 'custom', label: 'custom' },
    ]);
  });
});
