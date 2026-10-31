import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CategoryTabs } from './CategoryTabs';
import { matchesCategory, type CategoryFilter } from './shop-categories';
import { product, purchase } from './test-fixtures';
import content from './content.json';

// 真实受控组件证明键盘切换同时更新选中项与内容。
function Categories() {
  const [filter, setFilter] = useState<CategoryFilter>({ group: 'all', category: '' });
  return <CategoryTabs value={filter} onChange={setFilter}><p>{filter.group}/{filter.category}</p></CategoryTabs>;
}

describe('两级商品分类', () => {
  it('按用途与穿戴槽位筛选，历史双用途订单保留两种入口', () => {
    const dual = { ...purchase, type_snapshot: 'island' as const, island_item_key: 'star', portrait_type: 'accessory' as const };
    expect(matchesCategory(dual, { group: 'island', category: '' })).toBe(true);
    expect(matchesCategory(dual, { group: 'appearance', category: 'accessory' })).toBe(true);
    expect(matchesCategory(dual, { group: 'appearance', category: 'hair' })).toBe(false);
    expect(matchesCategory({ ...product, wearable_slot: 'hair' }, { group: 'appearance', category: 'hair' })).toBe(true);
    expect(matchesCategory({ ...product, wearable_slot: 'hair' }, { group: 'appearance', category: 'accessory' })).toBe(false);
    expect(matchesCategory({ ...purchase, type_snapshot: 'reward' }, { group: 'appearance', category: '' })).toBe(false);
    expect(matchesCategory({ ...purchase, type_snapshot: 'reward' }, { group: 'all', category: '' })).toBe(true);
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
    expect(details.getByRole('tab', { name: content.wearableSlots.hair })).toHaveFocus();
    expect(screen.getByText('appearance/hair')).toBeInTheDocument();
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
