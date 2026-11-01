import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import { ShopPage } from './ShopPage';
import { camp, product, purchase } from './test-fixtures';
import content from './content.json';
import { useAppearance } from '../character/AppearanceProvider';
import { appearanceFixture } from './appearance-test-fixtures';

vi.mock('../character/AppearanceProvider', async () => {
  const { appearanceFixture } = await import('./appearance-test-fixtures');
  return { useAppearance: vi.fn(() => ({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn(), publishSaved: vi.fn() })) };
});

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

beforeEach(() => {
  vi.mocked(useAppearance).mockReturnValue({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn(), publishSaved: vi.fn() });
});

describe('商店页面读取与动作边界', () => {
  it.each([
    { diamond_price: 2, owned_count: 3, owned: true, repeatable: true },
    { diamond_price: 0, owned_count: 0, owned: false, repeatable: true },
    { diamond_price: 0, owned_count: undefined, owned: true, repeatable: false },
  ])('商品卡片只展示名称、图片和图标旁的价格及已有数量：%j', async (ownership) => {
    const item = { ...product, ...ownership, island_item_key: 'book' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path.startsWith('/products')) return { items: [item] };
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

  it('购买后保留两级分类；读取失败只重读，不重复购买或自动装备', async () => {
    const garment = { ...product, type: 'wearable' as const, wearable_key: 'upper-owned', name: '远足上装' };
    const ownedGarment = { ...purchase, type_snapshot: 'wearable' as const, wearable_key: 'upper-owned' };
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    let purchased = false;
    let failedRead = false;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/purchases') {
        purchased = true;
        return { purchase: ownedGarment, wallet: camp.wallet };
      }
      if (path === '/camp') {
        if (purchased && !failedRead) {
          failedRead = true;
          throw new TypeError('read offline');
        }
        return camp;
      }
      if (path.startsWith('/products')) return { items: [{ ...garment, owned: purchased, owned_count: purchased ? 1 : 0 }] };
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    await screen.findByRole('button', { name: `${content.buy} ${garment.name}` });
    fireEvent.click(screen.getByRole('tab', { name: '角色装扮' }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.upper }));
    await screen.findByRole('button', { name: `${content.buy} ${garment.name}` });
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${garment.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.purchaseSuccess);
    fireEvent.click(await screen.findByRole('button', { name: content.reload }));
    await waitFor(() => expect(screen.getByRole('button', { name: `${content.buy} ${garment.name}` })).toBeDisabled());
    expect(screen.getByRole('tab', { name: '角色装扮' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: content.wearableSlots.upper })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('article')).getByRole('img', { name: content.ownedCount }).parentElement).toHaveTextContent('1');
    expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(1);
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0].detail).toBe('purchase');
    expect(screen.getByRole('status')).toHaveClass('feedback-success');
    window.removeEventListener(FEEDBACK_EVENT, feedback);
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment'))).toBe(false);
  });

  it.each([
    { type: 'reward' as const, group: '奖励', message: content.rewardPurchased, island_item_key: undefined },
    { type: 'island' as const, group: '营地物品', message: content.islandPurchased, island_item_key: 'book' },
  ])('$group 购买后仍在当前商店分类', async ({ type, group, message, island_item_key }) => {
    let purchased = false;
    const item = { ...product, type, island_item_key, repeatable: true };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path.startsWith('/products')) return { items: [{ ...item, owned_count: purchased ? 1 : 0 }] };
      if (path === '/purchases') {
        purchased = true;
        return { purchase: { ...purchase, type_snapshot: type, island_item_key }, wallet: camp.wallet };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    await screen.findByRole('heading', { name: item.name });
    fireEvent.click(screen.getByRole('tab', { name: group }));
    await screen.findByRole('button', { name: `${content.buy} ${item.name}` });
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(message);
    await waitFor(() => expect(within(screen.getByRole('article')).getByRole('img', { name: content.ownedCount }).parentElement).toHaveTextContent('1'));
    expect(screen.getByRole('tab', { name: group })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/purchases?'))).toBe(false);
  });

  it('商店按服装定义分类，营地物品不混入角色装扮', async () => {
    const hair = { ...product, id: 'hair', name: '短发', type: 'wearable' as const, wearable_key: 'hair-owned' };
    const island = { ...product, id: 'island', type: 'island' as const, name: '营地树木', island_item_key: 'star' };
    const reward = { ...product, id: 'reward', name: '家庭奖励', type: 'reward' as const };
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? camp : { items: [hair, island, reward] });
    render(<ShopPage client={{ request }} session={session} />);
    await screen.findByRole('heading', { name: hair.name });
    fireEvent.click(screen.getByRole('tab', { name: '角色装扮' }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    expect(await screen.findByRole('heading', { name: hair.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: island.name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '营地物品' }));
    expect(await screen.findByRole('heading', { name: island.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: hair.name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '角色装扮' }));
    expect(within(screen.getByRole('tablist', { name: '装扮分类' })).getByRole('tab', { name: content.allTypes })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('heading', { name: island.name })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: hair.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: reward.name })).not.toBeInTheDocument();
  });

  it('服装目录加载与失败单独反馈，恢复后沿用已选分类显示商品', async () => {
    const garment = { ...product, type: 'wearable' as const, wearable_key: 'hair-owned' };
    const refresh = vi.fn();
    const unavailable = { snapshot: null, loading: true, error: null, refresh, publishSaved: vi.fn() };
    vi.mocked(useAppearance).mockReturnValue(unavailable);
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? camp : { items: [garment] });
    const props = { client: { request }, session };
    const view = render(<ShopPage {...props} />);
    await screen.findByRole('heading', { name: garment.name });
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.appearance }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    expect(screen.getByRole('status')).toHaveTextContent(content.loading);
    expect(screen.queryByText(content.emptyCategoryProducts)).not.toBeInTheDocument();
    vi.mocked(useAppearance).mockReturnValue({ ...unavailable, loading: false, error: new TypeError('offline') });
    view.rerender(<ShopPage {...props} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(content.emptyCategoryProducts)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    expect(refresh).toHaveBeenCalledOnce();
    vi.mocked(useAppearance).mockReturnValue({ ...unavailable, snapshot: appearanceFixture(), loading: false });
    view.rerender(<ShopPage {...props} />);
    expect(await screen.findByRole('heading', { name: garment.name })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: content.wearableSlots.hair })).toHaveAttribute('aria-selected', 'true');
    expect(request.mock.calls.filter(([path]) => path === '/camp')).toHaveLength(1);
  });

});
