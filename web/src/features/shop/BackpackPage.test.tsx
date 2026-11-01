import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackpackPage } from './BackpackPage';
import type { Purchase, PurchaseList, ShopClient } from './types';
import type { Session } from '../../api/types';
import { purchase } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import content from './content.json';
import { useAppearance } from '../character/AppearanceProvider';
import { appearanceFixture, deferred } from './appearance-test-fixtures';

vi.mock('../character/AppearanceProvider', async () => {
  const { appearanceFixture } = await import('./appearance-test-fixtures');
  return { useAppearance: vi.fn(() => ({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn(), publishSaved: vi.fn() })) };
});

// 分页与奖励夹具保留真实订单的类型、状态及能力字段。
const hair: Purchase = { ...purchase, id: 'hair', name_snapshot: '短发', type_snapshot: 'wearable', wearable_key: 'hair-owned' };
const reward: Purchase = { ...purchase, id: 'reward', type_snapshot: 'reward', name_snapshot: '看电影', status: 'pending' };
const redeemed: Purchase = { ...reward, id: 'redeemed', name_snapshot: '吃冰淇淋', status: 'redeemed' };
const island: Purchase = { ...purchase, id: 'tree', name_snapshot: '树木', type_snapshot: 'island', island_item_key: 'tree' };
const book: Purchase = { ...purchase, id: 'book', name_snapshot: '书本', type_snapshot: 'island', island_item_key: 'book' };
const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

beforeEach(() => {
  vi.mocked(useAppearance).mockReturnValue({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn(), publishSaved: vi.fn() });
});

// 页面入口来自应用层，测试只记录导航请求。
function renderBackpack(request: ShopClient['request']) {
  const callbacks = { onBack: vi.fn(), onAppearance: vi.fn(), onTitle: vi.fn(), onIsland: vi.fn() };
  render(<BackpackPage client={{ request }} session={session} {...callbacks} />);
  return callbacks;
}

describe('背包分类与奖励', () => {
  it('全部包含永久物品、待兑现和已兑现奖励，并提供独立入口', async () => {
    const request = vi.fn().mockResolvedValue({ items: [purchase, reward, redeemed], next_cursor: null });
    const callbacks = renderBackpack(request);
    await screen.findByRole('heading', { name: reward.name_snapshot });
    expect(screen.getByRole('heading', { name: purchase.name_snapshot })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: redeemed.name_snapshot })).toBeInTheDocument();
    expect(request.mock.calls[0]?.[0]).toBe('/purchases');
    fireEvent.click(screen.getByRole('button', { name: content.backHome }));
    fireEvent.click(screen.getByRole('button', { name: content.wardrobeTitle }));
    fireEvent.click(screen.getByRole('button', { name: content.goToIsland }));
    fireEvent.click(screen.getByRole('button', { name: content.manageTitles }));
    expect(callbacks.onTitle).toHaveBeenCalledOnce();
    expect(callbacks.onBack).toHaveBeenCalledOnce();
    expect(callbacks.onAppearance).toHaveBeenCalledOnce();
    expect(callbacks.onIsland).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });

  it('发型使用服装查询且保留后续分页，不因第一页没有匹配项宣称为空', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('cursor=')) return { items: [hair], next_cursor: null };
      if (path.includes('type=wearable')) return { items: [purchase], next_cursor: 'hair-next' };
      return { items: [purchase], next_cursor: null };
    });
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.appearance }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    const more = await screen.findByRole('button', { name: content.more });
    expect(screen.queryByText(content.emptyCategoryPurchases)).not.toBeInTheDocument();
    expect(screen.getByText(content.moreHint)).toBeInTheDocument();
    fireEvent.click(more);
    await screen.findByRole('heading', { name: hair.name_snapshot });
    const nextQuery = new URL(String(request.mock.calls.at(-1)?.[0]), 'http://test').searchParams;
    expect(nextQuery.get('type')).toBe('wearable');
    expect(nextQuery.get('status')).toBe('owned');
    expect(nextQuery.get('cursor')).toBe('hair-next');
    expect(screen.queryByRole('heading', { name: purchase.name_snapshot })).not.toBeInTheDocument();
  });

  it('营地只显示明确的营地订单，切换分类不沿用之前的游标', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => ({
      items: [island, book, purchase], next_cursor: path.includes('cursor=') ? null : 'next-page',
    }));
    renderBackpack(request);
    await screen.findByRole('heading', { name: island.name_snapshot });
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.island }));
    await screen.findByRole('heading', { name: book.name_snapshot });
    expect(screen.getByRole('heading', { name: island.name_snapshot })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: purchase.name_snapshot })).not.toBeInTheDocument();
    const query = new URL(String(request.mock.calls.at(-1)?.[0]), 'http://test').searchParams;
    expect(query.get('status')).toBe('owned');
    expect(query.get('type')).toBe('island');
    expect(query.has('cursor')).toBe(false);
  });

  it('奖励分页沿用兑现状态，切换已兑现后重置游标', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => ({
      items: path.includes('status=redeemed') ? [redeemed] : [reward],
      next_cursor: path.includes('cursor=') || path.includes('status=redeemed') ? null : 'reward-next',
    }));
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.reward }));
    fireEvent.click(await screen.findByRole('button', { name: content.more }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => {
      const query = new URL(String(path), 'http://test').searchParams;
      return query.get('type') === 'reward' && query.get('status') === 'pending' && query.get('cursor') === 'reward-next';
    })).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: content.redeemed }));
    await screen.findByRole('heading', { name: redeemed.name_snapshot });
    expect(screen.queryByRole('heading', { name: reward.name_snapshot })).not.toBeInTheDocument();
    const query = new URL(String(request.mock.calls.at(-1)?.[0]), 'http://test').searchParams;
    expect(query.get('status')).toBe('redeemed');
    expect(query.has('cursor')).toBe(false);
  });

  it('迟到的旧分类响应不能覆盖当前营地分类', async () => {
    let finishOld!: (value: PurchaseList) => void;
    const request = vi.fn().mockImplementation((path: string) => path === '/purchases'
      ? new Promise<PurchaseList>((resolve) => { finishOld = resolve; })
      : Promise.resolve({ items: [island], next_cursor: null }));
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.island }));
    await screen.findByRole('heading', { name: island.name_snapshot });
    finishOld({ items: [purchase], next_cursor: 'old-cursor' });
    await waitFor(() => expect(screen.getByRole('heading', { name: island.name_snapshot })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: purchase.name_snapshot })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: content.more })).not.toBeInTheDocument();
  });

  it('兑现成功后留在背包原分类，刷新失败只重试读取', async () => {
    let committed = false;
    let failRead = false;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('/redeem')) { committed = true; failRead = true; return { ...reward, status: 'redeemed' }; }
      if (failRead) { failRead = false; throw new TypeError('offline'); }
      return { items: committed ? [] : [reward], next_cursor: null };
    });
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.reward }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.redeem} ${reward.name_snapshot}` }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(content.redeemPassword), { target: { value: 'secret' } });
    fireEvent.click(dialog.getByRole('button', { name: content.confirmRedeem }));
    await screen.findByText(content.redeemSuccess);
    fireEvent.click(await screen.findByRole('button', { name: content.reload }));
    await screen.findByText(content.emptyCategoryPurchases);
    expect(screen.getByRole('tab', { name: content.categoryGroups.reward })).toHaveAttribute('aria-selected', 'true');
    expect(request.mock.calls.filter(([path]) => String(path).endsWith('/redeem'))).toHaveLength(1);
  });

  it('两个槽位共用服装查询路径，切换后旧第一页和后续页都不能覆盖当前槽位', async () => {
    const staleFirst = deferred<PurchaseList>();
    const staleMore = deferred<PurchaseList>();
    const upper: Purchase = { ...purchase, id: 'upper', type_snapshot: 'wearable', wearable_key: 'upper-owned', name_snapshot: '上装实例' };
    let reads = 0;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('cursor=')) return staleMore.promise;
      if (path.includes('type=wearable')) {
        reads += 1;
        if (reads === 1) return staleFirst.promise;
        if (reads === 2) return { items: [upper], next_cursor: 'upper-next' };
        return { items: [hair], next_cursor: null };
      }
      return { items: [], next_cursor: null };
    });
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.appearance }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.upper }));
    await screen.findByRole('heading', { name: upper.name_snapshot });
    await act(async () => staleFirst.resolve({ items: [hair], next_cursor: 'stale-first' }));
    expect(screen.getByRole('heading', { name: upper.name_snapshot })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    await screen.findByRole('heading', { name: hair.name_snapshot });
    await act(async () => staleMore.resolve({ items: [upper], next_cursor: 'stale-more' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: content.more })).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: upper.name_snapshot })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path === '/purchases?status=owned&type=wearable')).toHaveLength(3);
  });

  it('缺少服装目录时显示读取失败与重试，不误报空库存', async () => {
    const refresh = vi.fn();
    vi.mocked(useAppearance).mockReturnValue({ snapshot: null, loading: false, error: new TypeError('offline'), refresh, publishSaved: vi.fn() });
    const request = vi.fn().mockResolvedValue({ items: [hair], next_cursor: null });
    renderBackpack(request);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.appearance }));
    fireEvent.click(screen.getByRole('tab', { name: content.wearableSlots.hair }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(content.emptyCategoryPurchases)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
