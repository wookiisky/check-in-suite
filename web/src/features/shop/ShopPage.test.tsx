import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ShopPage } from './ShopPage';
import { camp, equipment, product, purchase } from './test-fixtures';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('商店页面读取与动作边界', () => {
  it('购买成功切换我的装扮；后续读取失败只重试读取，不重复购买或自动装备', async () => {
    let purchased = false;
    let failedRead = false;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/purchases') {
        purchased = true;
        return { purchase, wallet: camp.wallet };
      }
      if (path === '/camp') {
        if (purchased && !failedRead) {
          failedRead = true;
          throw new TypeError('read offline');
        }
        return camp;
      }
      if (path === '/products') return { items: [product] };
      if (path.startsWith('/purchases?')) return { items: [purchase], next_cursor: null };
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.buy} ${product.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.purchaseSuccess);
    fireEvent.click(await screen.findByRole('button', { name: content.reload }));
    await screen.findByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` });
    expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment'))).toBe(false);
  });

  it('奖励列表提示尚未加载完并按原筛选取下一页', async () => {
    const reward = { ...purchase, type_snapshot: 'reward', status: 'pending' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [] };
      if (path.includes('cursor='))
        return { items: [{ ...reward, id: 'p2', name_snapshot: '第二个奖励' }], next_cursor: null };
      return { items: [reward], next_cursor: 'next-page' };
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.rewards }));
    await screen.findByText(content.moreHint);
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    await screen.findByText('第二个奖励');
    expect(
      request.mock.calls.some(
        ([path]) => path === '/purchases?type=reward&status=pending&cursor=next-page',
      ),
    ).toBe(true);
    expect(screen.queryByText(content.moreHint)).not.toBeInTheDocument();
  });

  it('饰品装备只写指定物品，失败后不移除其他装备', async () => {
    const equipped = { ...purchase, id: 'existing', name_snapshot: '已有饰品' };
    const extra = { ...purchase, id: 'extra', name_snapshot: '新饰品' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp')
        return { ...camp, equipment: { ...equipment, accessories: [equipped] } };
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?')) return { items: [equipped, extra], next_cursor: null };
      if (path === '/equipment/accessories/extra') throw new TypeError('offline');
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} 新饰品` }));
    await screen.findByRole('button', { name: content.reload });
    expect(screen.getByRole('button', { name: `${content.unequip} 已有饰品` })).toBeEnabled();
    expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toEqual([
      ['/equipment/accessories/extra', { method: 'PUT' }],
    ]);
  });
});
