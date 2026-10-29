import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Wardrobe } from './Wardrobe';
import { equipment, fullEquipment, purchase } from './test-fixtures';
import type { Purchase } from './types';
import content from './content.json';

describe('固定穿戴与自由饰品分开装备', () => {
  it('饰品满额时仍可装备发型，已穿戴物品可独立卸下', () => {
    const hair: Purchase = { ...purchase, id: 'hair', name_snapshot: '卷发', asset_key_snapshot: 'hair-curly-v1', wearable_slot: 'hair' };
    const top: Purchase = { ...purchase, id: 'top', name_snapshot: '探险上衣', asset_key_snapshot: 'wearable-top-explorer-v1', wearable_slot: 'top' };
    const onToggle = vi.fn();
    render(<Wardrobe items={[hair, top, purchase]} equipment={{ ...fullEquipment, wearables: { ...equipment.wearables, top } }} busy={false} onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: `${content.equip} ${hair.name_snapshot}` })).toBeEnabled();
    expect(screen.getByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: `${content.unequip} ${top.name_snapshot}` }));
    expect(onToggle).toHaveBeenCalledWith(top, false);
  });

  it('未读取完筛选结果时不宣称没有物品', () => {
    render(<Wardrobe items={[]} equipment={equipment} busy={false} hasMore onToggle={vi.fn()} />);
    expect(screen.queryByText(content.emptyPurchases)).not.toBeInTheDocument();
  });
});
