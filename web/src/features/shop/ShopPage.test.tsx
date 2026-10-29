import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import { ShopPage } from './ShopPage';
import { camp, equipment, product, purchase } from './test-fixtures';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('商店页面读取与动作边界', () => {
  it.each([
    { diamond_price: 2, owned_count: 3, owned: true, repeatable: true },
    { diamond_price: 0, owned_count: 0, owned: false, repeatable: true },
    { diamond_price: 0, owned_count: undefined, owned: true, repeatable: false },
  ])('商品卡片只展示名称、图片和图标旁的价格及已有数量：%j', async (ownership) => {
    const item = { ...product, ...ownership, island_item_key: 'book' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [item] };
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    await screen.findByRole('heading', { name: item.name });
    const card = within(screen.getByRole('article'));
    expect(card.getByRole('img', { name: content.coins }).parentElement).toHaveTextContent(String(item.coin_price));
    expect(card.getByRole('img', { name: content.ownedCount }).parentElement).toHaveTextContent(
      String(item.owned_count ?? (item.owned ? 1 : 0)),
    );
    if (item.diamond_price > 0) {
      expect(card.getByRole('img', { name: content.diamonds }).parentElement).toHaveTextContent(String(item.diamond_price));
    } else {
      expect(card.queryByRole('img', { name: content.diamonds })).not.toBeInTheDocument();
    }
    expect(card.queryByText(item.description)).not.toBeInTheDocument();
    expect(card.queryByText(content.types[item.type])).not.toBeInTheDocument();
    expect(card.queryByText(content.dualUseHint)).not.toBeInTheDocument();
    expect(card.queryByText(content.repeatableHint)).not.toBeInTheDocument();
    expect(card.queryByText(new RegExp(content.stock))).not.toBeInTheDocument();
    const buy = card.getByRole('button', { name: `${content.buy} ${item.name}` });
    expect(buy).toHaveAccessibleDescription(expect.stringContaining(`${content.coins} ${item.coin_price}`));
    expect(within(buy).getByRole('img', { name: content.coins })).toBeInTheDocument();
    expect(within(buy).queryByRole('img', { name: content.ownedCount })).not.toBeInTheDocument();
    expect(buy).not.toHaveTextContent(content.buy);
    expect(buy).not.toHaveTextContent(content.buyAnother);
    if (item.diamond_price > 0) {
      expect(within(buy).getByRole('img', { name: content.diamonds })).toBeInTheDocument();
      expect(buy).toHaveAccessibleDescription(expect.stringContaining(`${content.diamonds} ${item.diamond_price}`));
    } else {
      expect(buy).not.toHaveAccessibleDescription(expect.stringContaining(content.diamonds));
    }
    if (item.owned && !item.repeatable) expect(buy).toBeDisabled();
    else expect(buy).toBeEnabled();
  });

  it.each([
    { changes: { owned: true }, reason: content.owned },
    { changes: { stock: 0 }, reason: content.soldOut },
    { changes: { coin_price: camp.wallet.coins + 1 }, reason: content.insufficient },
  ])('价格按钮保留不可购买的原因：$reason', async ({ changes, reason }) => {
    const request = vi.fn().mockImplementation(async (path: string) =>
      path === '/camp' ? camp : { items: [{ ...product, ...changes }] },
    );
    render(<ShopPage client={{ request }} session={session} />);
    const buy = await screen.findByRole('button', { name: `${content.buy} ${product.name}` });
    expect(buy).toBeDisabled();
    expect(buy).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(within(buy).getByRole('img', { name: content.coins })).toBeInTheDocument();
    expect(buy).not.toHaveTextContent(reason);
  });

  it('购买成功切换我的装扮；后续读取失败只重试读取，不重复购买或自动装备', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
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
    const buy = await screen.findByRole('button', { name: `${content.buy} ${product.name}` });
    expect(feedback).not.toHaveBeenCalled();
    fireEvent.click(buy);
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.purchaseSuccess);
    fireEvent.click(await screen.findByRole('button', { name: content.reload }));
    await screen.findByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` });
    expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(1);
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0].detail).toBe('purchase');
    expect(screen.getByRole('status')).toHaveClass('feedback-success');
    window.removeEventListener(FEEDBACK_EVENT, feedback);
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
    fireEvent.click(await screen.findByRole('button', { name: content.more }));
    await screen.findByText('第二个奖励');
    expect(
      request.mock.calls.some(
        ([path]) => path === '/purchases?type=reward&status=pending&cursor=next-page',
      ),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: content.more })).not.toBeInTheDocument();
  });

  it('饰品装备只写指定物品，失败后不移除其他装备', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const equipped = { ...purchase, id: 'existing', name_snapshot: '已有饰品' };
    const extra = { ...purchase, id: 'extra', name_snapshot: '新饰品' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp')
        return { ...camp, equipment: { ...equipment, accessories: [equipped], accessory_layouts: { [equipped.id]: { x: 0.5, y: 0.5, size: 0.2, layer: 1 } } } };
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
    expect(feedback).not.toHaveBeenCalled();
    window.removeEventListener(FEEDBACK_EVENT, feedback);
    expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toEqual([
      ['/equipment/accessories/extra', { method: 'PUT' }],
    ]);
  });

  it('背景使用独立槽位，特效逐件装备并保留原饰品', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const background = { ...purchase, id: 'bg', type_snapshot: 'background' as const, name_snapshot: '草地背景' };
    const effect = { ...purchase, id: 'effect', type_snapshot: 'effect' as const, name_snapshot: '雪花特效' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: { ...equipment, accessories: [purchase], accessory_layouts: { [purchase.id]: { x: 0.5, y: 0.5, size: 0.2, layer: 1 } } } };
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?')) return { items: [background, effect], next_cursor: null };
      return {};
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${background.name_snapshot}` }));
    await screen.findByText(content.equipmentSaved);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${effect.name_snapshot}` }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toEqual([
      ['/equipment/background', { method: 'PUT', body: { purchase_id: 'bg' } }],
      ['/equipment/effects/effect', { method: 'PUT' }],
    ]));
    await waitFor(() => expect(feedback).toHaveBeenCalledTimes(2));
    expect(feedback.mock.calls.every(([event]) => event.detail === 'equip')).toBe(true);
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });

  it('装备写成功后读取失败仍只反馈一次，读到新角色后才强调', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    let equipped = false;
    let failRead = true;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === `/equipment/accessories/${purchase.id}`) {
        equipped = true;
        return { purchase_id: purchase.id, equipped: true };
      }
      if (path === '/camp') {
        if (equipped && failRead) throw new TypeError('read offline');
        return equipped ? { ...camp, equipment: { ...equipment, accessories: [purchase], accessory_layouts: { [purchase.id]: { x: 0.5, y: 0.5, size: 0.2, layer: 1 } } } } : camp;
      }
      if (path === '/products') return { items: [] };
      return { items: [purchase], next_cursor: null };
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` }));
    await screen.findByRole('button', { name: content.reload });
    expect(screen.getByText(content.equipmentSaved)).toBeInTheDocument();
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.feedback-pop')).toBeNull();
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    expect(await screen.findByAltText(purchase.name_snapshot)).toBeInTheDocument();
    expect(document.querySelector('.feedback-pop')).not.toBeNull();
    expect(feedback).toHaveBeenCalledTimes(1);
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });

});
