import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CategoryTabs } from './CategoryTabs';
import { matchesCategory, type CategoryFilter } from './shop-categories';
import { product, purchase } from './test-fixtures';
import { appearanceFixture } from './appearance-test-fixtures';
import content from './content.json';

// 真实受控组件证明键盘切换同时更新选中项与内容。
function Categories() {
  const [filter, setFilter] = useState<CategoryFilter>({ group: 'all', category: '' });
  return <CategoryTabs value={filter} onChange={setFilter}><p>{filter.group}/{filter.category}</p></CategoryTabs>;
}

describe('两级商品分类', () => {
  it('按服装定义的槽位分类，名称和稳定key不参与判断', () => {
    const definitions = appearanceFixture().wearables.map((item) => ({ ...item, name: '与部位无关的名称', wearable_key: `arbitrary-${item.wearable_key.length}-${item.slot}` }));
    const definition = definitions.find((item) => item.slot === 'upper')!;
    const garment = { ...product, type: 'wearable' as const, wearable_key: definition.wearable_key };
    expect(matchesCategory(garment, { group: 'appearance', category: 'upper' }, definitions)).toBe(true);
    expect(matchesCategory(garment, { group: 'appearance', category: 'hair' }, definitions)).toBe(false);
    expect(matchesCategory({ ...garment, wearable_key: 'unknown-upper' }, { group: 'appearance', category: 'upper' }, definitions)).toBe(false);
    expect(matchesCategory({ ...purchase, type_snapshot: 'island', island_item_key: 'tree' }, { group: 'appearance', category: '' }, definitions)).toBe(false);
    expect(matchesCategory({ ...purchase, type_snapshot: 'island', island_item_key: 'tree' }, { group: 'island', category: '' }, definitions)).toBe(true);
    expect(matchesCategory({ ...purchase, type_snapshot: 'reward' }, { group: 'all', category: '' }, definitions)).toBe(true);
  });

  it('方向键、Home与End在当前层级切换，一级切换重置二级', () => {
    render(<Categories />);
    const groups = within(screen.getByRole('tablist', { name: '商品分类' }));
    const all = groups.getByRole('tab', { name: '全部' });
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    const appearance = groups.getByRole('tab', { name: '角色装扮' });
    expect(appearance).toHaveFocus();
    expect(appearance).toHaveAttribute('aria-selected', 'true');
    const details = within(screen.getByRole('tablist', { name: '装扮分类' }));
    const detailAll = details.getByRole('tab', { name: content.allTypes });
    detailAll.focus();
    fireEvent.keyDown(detailAll, { key: 'ArrowRight' });
    expect(details.getByRole('tab', { name: content.types.character })).toHaveFocus();
    expect(screen.getByText('appearance/character')).toBeInTheDocument();
    fireEvent.keyDown(appearance, { key: 'End' });
    expect(groups.getByRole('tab', { name: '奖励' })).toHaveFocus();
    expect(screen.queryByRole('tablist', { name: '装扮分类' })).not.toBeInTheDocument();
    fireEvent.keyDown(groups.getByRole('tab', { name: '奖励' }), { key: 'Home' });
    expect(all).toHaveFocus();
    fireEvent.click(appearance);
    expect(within(screen.getByRole('tablist', { name: '装扮分类' })).getByRole('tab', { name: content.allTypes })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '角色装扮' })).toBeInTheDocument();
  });
});
