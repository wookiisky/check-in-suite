import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { testSession } from '../../test/account-fixtures';
import { ShopPage } from './ShopPage';
import { BackpackPage } from './BackpackPage';
import { camp, product, purchase } from './test-fixtures';
import { deferred } from './appearance-test-fixtures';
import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

vi.mock('../character/AppearanceProvider', async () => {
  const { appearanceFixture } = await import('./appearance-test-fixtures');
  return { useAppearance: () => ({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn() }) };
});

describe('素材商品分页', () => {
  it('背包来源与搜索查询作用于全部订单，翻页保持相同筛选', async () => {
    const request = vi.fn(async (path: string) => {
      const query = new URL(path, 'http://fixture').searchParams;
      return { items: [{ ...purchase, id: query.has('cursor') ? 'next-order' : 'first-order', name_snapshot: query.has('cursor') ? '后页人物' : '已购人物', type_snapshot: 'character', character_key: 'knight' }], next_cursor: query.has('cursor') ? null : 'next-owned', facets: { providers: ['kaykit'], packs: [{ key: 'adventurers', provider: 'kaykit' }] } };
    });
    render(<BackpackPage client={{ request: request as ApiClient['request'] }} session={session} onBack={vi.fn()} onIsland={vi.fn()} onAppearance={vi.fn()} />);
    await screen.findByRole('heading', { name: '已购人物' });
    fireEvent.change(screen.getByLabelText('素材来源'), { target: { value: 'kaykit' } });
    fireEvent.change(screen.getByLabelText('搜索商品'), { target: { value: '人物' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: '继续加载' }));
    await screen.findByRole('heading', { name: '后页人物' });
    expect(Object.fromEntries(new URL(request.mock.calls.at(-1)![0], 'http://fixture').searchParams)).toMatchObject({ search: '人物', provider: 'kaykit', cursor: 'next-owned' });
  });

  it('查询在服务端筛选全部目录，翻页保留来源和素材包条件，图片延迟加载', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/camp') return camp;
      const query = new URL(path, 'http://fixture').searchParams;
      const nextPage = query.has('cursor');
      return { items: [{ ...product, id: nextPage ? 'second' : 'first', name: nextPage ? '第二件' : '第一件' }], next_cursor: nextPage ? null : 'page-two', facets: { providers: ['kaykit', 'kenney'], packs: [{ key: 'nature-kit', provider: 'kenney' }] } };
    });
    render(<ShopPage client={{ request: request as ApiClient['request'] }} session={session} />);
    await screen.findByRole('heading', { name: '第一件' });
    expect(request).toHaveBeenCalledWith('/products?limit=48', expect.anything());
    fireEvent.change(screen.getByLabelText('素材来源'), { target: { value: 'kenney' } });
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('provider=kenney'))).toBe(true));
    fireEvent.change(screen.getByLabelText('素材包'), { target: { value: 'nature-kit' } });
    fireEvent.change(screen.getByLabelText('搜索商品'), { target: { value: '树木' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('search=') && path.includes('pack_key=nature-kit'))).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: '继续加载' }));
    await screen.findByRole('heading', { name: '第二件' });
    const lastPath = request.mock.calls.at(-1)![0];
    const query = new URL(lastPath, 'http://fixture').searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ limit: '48', provider: 'kenney', pack_key: 'nature-kit', search: '树木', cursor: 'page-two' });
    expect(screen.queryByRole('button', { name: '继续加载' })).not.toBeInTheDocument();
    const image = screen.getAllByRole('article')[0]!.querySelector('.shop-product-art');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('分类改变后放弃旧页的迟到结果，未加载完时不宣称分类为空', async () => {
    const stale = deferred<unknown>();
    const request = vi.fn(async (path: string) => {
      if (path === '/camp') return camp;
      const query = new URL(path, 'http://fixture').searchParams;
      if (query.has('cursor')) return stale.promise;
      if (query.get('type') === 'island') return { items: [], next_cursor: 'island-next' };
      return { items: [product], next_cursor: 'old-next' };
    });
    render(<ShopPage client={{ request: request as ApiClient['request'] }} session={session} />);
    await screen.findByRole('heading', { name: product.name });
    fireEvent.click(screen.getByRole('button', { name: '继续加载' }));
    fireEvent.click(screen.getByRole('tab', { name: '营地物品' }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('type=island'))).toBe(true));
    await act(async () => stale.resolve({ items: [{ ...product, id: 'late', type: 'island', name: '迟到的物品' }], next_cursor: null }));
    expect(screen.queryByRole('heading', { name: '迟到的物品' })).not.toBeInTheDocument();
    expect(screen.queryByText('这个分类暂时没有商品。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续加载' })).toBeInTheDocument();
  });

  it('背包首次读取中重复提交相同搜索仍能结束加载', async () => {
    const first = deferred<unknown>();
    const request = vi.fn(() => first.promise);
    render(<BackpackPage client={{ request: request as ApiClient['request'] }} session={session} onBack={vi.fn()} onIsland={vi.fn()} onAppearance={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await act(async () => first.resolve({ items: [purchase], next_cursor: null }));
    expect(await screen.findByRole('heading', { name: purchase.name_snapshot })).toBeInTheDocument();
    expect(screen.queryByText('正在加载……')).not.toBeInTheDocument();
  });

  it('背包翻页中重复提交相同搜索不会丢弃该页或卡住翻页', async () => {
    const next = deferred<unknown>();
    const request = vi.fn(async (path: string) => new URL(path, 'http://fixture').searchParams.has('cursor')
      ? next.promise : { items: [purchase], next_cursor: 'next-owned' });
    render(<BackpackPage client={{ request: request as ApiClient['request'] }} session={session} onBack={vi.fn()} onIsland={vi.fn()} onAppearance={vi.fn()} />);
    await screen.findByRole('heading', { name: purchase.name_snapshot });
    fireEvent.click(screen.getByRole('button', { name: '继续加载' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await act(async () => next.resolve({ items: [{ ...purchase, id: 'next-owned', name_snapshot: '后页物品' }], next_cursor: null }));
    expect(await screen.findByRole('heading', { name: '后页物品' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续加载' })).not.toBeInTheDocument();
  });

});
