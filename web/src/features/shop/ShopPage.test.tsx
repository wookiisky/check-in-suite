import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { errorMessage } from '../../api/client';
import { testSession } from '../../test/account-fixtures';
import { ShopPage } from './ShopPage';
import { camp, product, purchase } from './test-fixtures';
import content from './content.json';
import pagination from '../../components/numbered-pagination-content.json';

const first = { ...product, id: 'a', type: 'island' as const, island_item_key: 'desk', name: '书桌', repeatable: true };
const alias = { ...first, id: 'a2', name: '另一报价' };
const second = { ...first, id: 'b', island_item_key: 'stool', name: '凳子' };
const third = { ...first, id: 'c', island_item_key: 'bed', name: '床' };
const fourth = { ...first, id: 'd', island_item_key: 'sofa', name: '沙发' };
const session = { ...testSession, timezone: 'Asia/Taipei' as const };

it('按营地分类直接跳页，装扮入口替代原来的背包入口', async () => {
  const onAppearance = vi.fn();
  const request = vi.fn().mockImplementation(async (path: string) => {
    const url = new URL(path, 'https://example.test');
    if (url.pathname !== '/shop/products') throw new Error(path);
    const page = Number(url.searchParams.get('page'));
    return { items: page === 3 ? [third] : [first], page, total: 51, camp_categories: ['scene', 'furniture'], wallet: camp.wallet };
  });
  render(<ShopPage client={{ request }} session={session} onAppearance={onAppearance} />);

  expect(within(screen.getByRole('tablist', { name: content.categoryGroupLabel })).getAllByRole('tab')).toHaveLength(2);
  expect(screen.queryByRole('heading', { name: content.title })).not.toBeInTheDocument();
  expect(within(screen.getByRole('tablist', { name: content.categoryGroupLabel })).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: content.backpack })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '装扮' }));
  expect(onAppearance).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('tab', { name: '营地' }));
  fireEvent.click(await screen.findByRole('tab', { name: '家具' }));
  await screen.findByRole('heading', { name: first.name });
  expect(screen.queryByRole('button', { name: '一键购买' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole('spinbutton', { name: pagination.page }), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: pagination.jump }));
  await screen.findByRole('heading', { name: third.name });
  expect(request.mock.calls.at(-1)?.[0]).toContain('group=camp&category=furniture&page=3');
  expect(screen.getByRole('tab', { name: '家具' })).toHaveAttribute('aria-selected', 'true');
});

it('开发环境允许从一级分类栏一键购买，完成后重读当前分类', async () => {
  let bought = false;
  let complete = () => {};
  const nextWallet = { ...camp.wallet, version: camp.wallet.version + 1 };
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/shop/development/buy-all') {
      await new Promise<void>((resolve) => { complete = resolve; });
      bought = true;
      return nextWallet;
    }
    return {
      items: bought ? [] : [first],
      page: 1, total: bought ? 0 : 1, camp_categories: ['furniture'],
      wallet: bought ? nextWallet : camp.wallet, development_buy_all: true,
    };
  });
  render(<ShopPage client={{ request }} session={session} onAppearance={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '营地' }));
  const action = await screen.findByRole('button', { name: '一键购买' });
  expect(action.parentElement).toContainElement(screen.getByRole('button', { name: content.openAppearance }));
  expect(action.parentElement?.previousElementSibling).toBe(screen.getByRole('tablist', { name: content.categoryGroupLabel }));

  fireEvent.click(action);
  expect(action).toBeDisabled();
  expect(screen.getByRole('button', { name: `${content.buy} ${first.name}` })).toBeDisabled();
  fireEvent.click(action);
  expect(request.mock.calls.filter(([path]) => path === '/shop/development/buy-all')).toEqual([
    ['/shop/development/buy-all', { method: 'POST' }],
  ]);
  complete();

  await screen.findByText(content.emptyCategoryProducts);
  expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '营地' })).toHaveAttribute('aria-selected', 'true');
  expect(request.mock.calls.at(-1)?.[0]).toContain('group=camp&category=&page=1');
});

it('一键购买失败后保留商品并允许重试', async () => {
  const failure = new Error('disconnected');
  const buyAll = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(camp.wallet);
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/shop/development/buy-all') return buyAll();
    const bought = buyAll.mock.calls.length > 1;
    return {
      items: bought ? [] : [first],
      page: 1, total: bought ? 0 : 1, camp_categories: [], wallet: camp.wallet,
      development_buy_all: true,
    };
  });
  render(<ShopPage client={{ request }} session={session} />);
  fireEvent.click(await screen.findByRole('button', { name: content.buyAll }));
  expect(await screen.findByRole('alert')).toHaveTextContent(errorMessage(failure));
  expect(screen.getByRole('heading', { name: first.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: content.buyAll }));
  await screen.findByText(content.buyAllSuccess);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('购买后当页置灰、补齐页边界，继续翻页不漏商品', async () => {
  let bought = false;
  const afterPurchase = { ...camp.wallet, coins: 90, diamonds: 18, version: 2 };
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/purchases') {
      bought = true;
      return { purchase: { ...purchase, product_id: first.id, type_snapshot: 'island', island_item_key: first.island_item_key }, wallet: afterPurchase };
    }
    const url = new URL(path, 'https://example.test');
    if (url.pathname !== '/shop/products') throw new Error(path);
    const page = Number(url.searchParams.get('page'));
    const items = page === 2 ? [fourth] : bought ? [second, third] : [first, alias, second];
    return { items, page, total: bought ? 25 : 27, camp_categories: ['scene', 'furniture'], wallet: bought ? afterPurchase : camp.wallet };
  });
  render(<ShopPage client={{ request }} session={session} />);
  fireEvent.click(screen.getByRole('tab', { name: '营地' }));
  fireEvent.click(await screen.findByRole('button', { name: `${content.buy} ${first.name}` }));
  fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));

  await screen.findByText(content.islandPurchased);
  expect(screen.getByRole('button', { name: `${content.buy} ${first.name}` })).toBeDisabled();
  expect(screen.getByRole('button', { name: `${content.buy} ${alias.name}` })).toBeDisabled();
  await screen.findByRole('heading', { name: third.name });
  expect(screen.getAllByRole('article')[0]).toHaveTextContent(first.name);
  expect(screen.getAllByRole('article')[1]).toHaveTextContent(alias.name);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: pagination.next }));
  await screen.findByRole('heading', { name: fourth.name });
  expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(1);
});

it.each([
  { changes: { stock: 0 }, reason: content.soldOut },
  { changes: { coin_price: camp.wallet.coins + 1 }, reason: content.insufficient },
])('不可购买的价格按钮保留原因：$reason', async ({ changes, reason }) => {
  const item = { ...first, ...changes };
  const request = vi.fn().mockResolvedValue({ items: [item], page: 1, total: 1, camp_categories: [], wallet: camp.wallet });
  render(<ShopPage client={{ request }} session={session} />);
  const buy = await screen.findByRole('button', { name: `${content.buy} ${item.name}` });
  expect(buy).toBeDisabled();
  expect(buy).toHaveAccessibleDescription(expect.stringContaining(reason));
  expect(within(buy).getByRole('img', { name: content.coins })).toBeInTheDocument();
  expect(buy).not.toHaveTextContent(reason);
});

it('切换分类后丢弃较早的迟到响应', async () => {
  let resolveAppearance: (response: unknown) => void = () => {};
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path.includes('group=appearance')) return new Promise((resolve) => { resolveAppearance = resolve; });
    return { items: [first], page: 1, total: 1, camp_categories: ['furniture'], wallet: camp.wallet };
  });
  render(<ShopPage client={{ request }} session={session} />);
  fireEvent.click(screen.getByRole('tab', { name: '营地' }));
  await screen.findByRole('heading', { name: first.name });
  resolveAppearance({ items: [second], page: 1, total: 1, camp_categories: [], wallet: camp.wallet });
  await waitFor(() => expect(screen.getByRole('tab', { name: '营地' })).toHaveAttribute('aria-selected', 'true'));
  expect(screen.getByRole('heading', { name: first.name })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: second.name })).not.toBeInTheDocument();
});

it('末页售完仍显示成交卡片，可以返回仍有商品的上一页', async () => {
  let bought = false;
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/purchases') {
      bought = true;
      return { purchase: { ...purchase, product_id: second.id, type_snapshot: 'island' }, wallet: camp.wallet };
    }
    const requestedPage = Number(new URL(path, 'https://example.test').searchParams.get('page'));
    const page = bought ? 1 : requestedPage;
    return { items: page === 2 ? [second] : [first], page, total: bought ? 24 : 25, camp_categories: [], wallet: camp.wallet };
  });
  render(<ShopPage client={{ request }} session={session} />);
  fireEvent.click(await screen.findByRole('button', { name: pagination.next }));
  fireEvent.click(await screen.findByRole('button', { name: `${content.buy} ${second.name}` }));
  fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
  await screen.findByText(content.islandPurchased);
  const previous = screen.getByRole('button', { name: pagination.previous });
  await waitFor(() => expect(previous).toBeEnabled());
  expect(screen.getByRole('button', { name: `${content.buy} ${second.name}` })).toBeDisabled();
  expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument();
  fireEvent.click(previous);
  await screen.findByRole('heading', { name: first.name });
  expect(screen.queryByRole('navigation', { name: pagination.label })).not.toBeInTheDocument();
});
