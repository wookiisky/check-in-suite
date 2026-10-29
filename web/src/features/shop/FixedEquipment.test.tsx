import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShopPage } from './ShopPage';
import { camp, equipment, purchase } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Equipment, Purchase } from './types';
import type { Session } from '../../api/types';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('免费形象与固定穿戴', () => {
  it('动物形象提示穿戴暂不显示，切回人类后保留装备', async () => {
    const hair: Purchase = { ...purchase, id: 'hair', name_snapshot: '卷发', wearable_slot: 'hair', asset_key_snapshot: 'hair-curly-v1' };
    let current: Equipment = { ...equipment, avatar: { ...purchase, type_snapshot: 'avatar', asset_key_snapshot: 'bunny-v1' }, wearables: { ...equipment.wearables, hair } };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: current };
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?')) return { items: [hair], next_cursor: null };
      if (path === '/equipment/base-avatar') { current = { ...current, avatar: null }; return current; }
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    expect(await screen.findByRole('button', { name: `${content.unequip} ${hair.name_snapshot}` })).toBeEnabled();
    expect(screen.getByRole('button', { name: content.baseAvatarNames['avatar-boy-v2'] })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: content.baseAvatarNames['avatar-boy-v2'] }));
    await waitFor(() => expect(screen.getByRole('button', { name: content.baseAvatarNames['avatar-boy-v2'] })).toHaveAttribute('aria-pressed', 'true'));
    expect(current.wearables.hair).toEqual(hair);
  });
  it('切换免费基础形象不创建订单，并保留已装备的衣服', async () => {
    const top: Purchase = { ...purchase, id: 'top', wearable_slot: 'top' };
    let current: Equipment = { ...equipment, wearables: { ...equipment.wearables, top } };
    const request = vi.fn().mockImplementation(async (path: string, options?: { body?: { asset_key?: string } }) => {
      if (path === '/camp') return { ...camp, equipment: current };
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?')) return { items: [top], next_cursor: null };
      if (path === '/equipment/base-avatar') {
        current = { ...current, base_avatar_key: options!.body!.asset_key!, avatar: null };
        return current;
      }
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    fireEvent.click(await screen.findByRole('button', { name: content.baseAvatarNames['avatar-girl-v2'] }));
    await waitFor(() => expect(screen.getByRole('button', { name: content.baseAvatarNames['avatar-girl-v2'] })).toHaveAttribute('aria-pressed', 'true'));
    expect(current.wearables.top).toEqual(top);
    expect(request.mock.calls.filter(([path]) => path.startsWith('/equipment'))).toEqual([
      ['/equipment/base-avatar', { method: 'PUT', body: { asset_key: 'avatar-girl-v2' } }],
    ]);
  });

  it('发型筛选继续读取饰品后续页，装备时写固定部位', async () => {
    const hair: Purchase = { ...purchase, id: 'hair', name_snapshot: '卷发', wearable_slot: 'hair', asset_key_snapshot: 'hair-curly-v1' };
    let current = equipment;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: current };
      if (path === '/products') return { items: [] };
      if (path === '/equipment/hair') {
        current = { ...current, wearables: { ...current.wearables, hair } };
        return current;
      }
      if (path.includes('cursor=')) return { items: [hair], next_cursor: null };
      if (path.includes('type=accessory')) return { items: [purchase], next_cursor: 'page-2' };
      return { items: [], next_cursor: null };
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    await screen.findByRole('button', { name: content.baseAvatarNames['avatar-boy-v2'] });
    fireEvent.change(screen.getByRole('combobox', { name: content.typeFilter }), { target: { value: 'hair' } });
    await screen.findByRole('button', { name: content.more });
    expect(screen.queryByText(content.emptyPurchases)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${hair.name_snapshot}` }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/equipment/hair', { method: 'PUT', body: { purchase_id: hair.id } }));
    expect(request).toHaveBeenCalledWith('/purchases?status=owned&type=accessory&cursor=page-2');
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment/accessories'))).toBe(false);
  });
});
