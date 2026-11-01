import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShopPage } from './ShopPage';
import { BackpackPage } from './BackpackPage';
import { canBuy } from './helpers';
import { camp, product, purchase, wallet } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

// 双用途与重复购买测试数据不改变正式物品定义。
const tree = { ...product, id: 'tree', type: 'island' as const, name: '小岛树木', island_item_key: 'tree', repeatable: true, owned: true, owned_count: 2 };
const book = { ...product, id: 'book', type: 'island' as const, name: '营地书本', island_item_key: 'book' };
const treePurchase = { ...purchase, id: 'tree-owned', type_snapshot: 'island' as const, island_item_key: 'tree', name_snapshot: tree.name };

describe('小岛商店与多件所有权', () => {
  it('已拥有的可重复物品仍可购买，库存和双币条件继续生效', () => {
    expect(canBuy(tree, wallet)).toBe(true);
    expect(canBuy({ ...tree, stock: 0 }, wallet)).toBe(false);
    expect(canBuy(tree, { ...wallet, diamonds: 0 })).toBe(false);
    expect(canBuy({ ...tree, repeatable: false }, wallet)).toBe(false);
  });

  it('营地分类包含多个营地定义商品，购买后留在该分类且不自动装备', async () => {
    const onBackpack = vi.fn();
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [tree, book, product] };
      if (path === '/purchases') return { purchase: treePurchase, wallet };
      if (path.startsWith('/purchases?')) return { items: [treePurchase], next_cursor: null };
      throw new Error(`Unexpected request ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} onBackpack={onBackpack} />);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.island }));
    await screen.findByRole('button', { name: `${content.buy} ${tree.name}` });
    expect(screen.getByRole('button', { name: `${content.buy} ${book.name}` })).toBeEnabled();
    expect(screen.queryByRole('button', { name: `${content.buy} ${product.name}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${tree.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.islandPurchased);
    expect(screen.getByRole('tab', { name: content.categoryGroups.island })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: `${content.buy} ${tree.name}` })).toBeEnabled();
    expect(onBackpack).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment'))).toBe(false);
  });

  it('过滤后的第一页没有岛屿物品时保留翻页，不误报空库存', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [] };
      if (path.includes('cursor=')) return { items: [treePurchase], next_cursor: null };
      return { items: [purchase], next_cursor: 'next' };
    });
    render(<BackpackPage client={{ request }} session={session} onBack={vi.fn()} onIsland={vi.fn()} onAppearance={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.island }));
    const more = await screen.findByRole('button', { name: content.more });
    expect(screen.queryByText(content.emptyCategoryPurchases)).not.toBeInTheDocument();
    fireEvent.click(more);
    await screen.findByText(tree.name);
  });

});
