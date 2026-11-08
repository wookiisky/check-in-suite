import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShopPage } from './ShopPage';
import { canBuy } from './helpers';
import { product, wallet } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import content from './content.json';

const tree = { ...product, id: 'tree', type: 'island' as const, name: '小岛树木', island_item_key: 'tree', repeatable: true, owned: true, owned_count: 2 };
const book = { ...product, id: 'book', type: 'island' as const, name: '营地书本', island_item_key: 'book' };

describe('营地商品所有权', () => {
  it('旧交易能力保持库存与双币条件', () => {
    expect(canBuy(tree, wallet)).toBe(true);
    expect(canBuy({ ...tree, stock: 0 }, wallet)).toBe(false);
    expect(canBuy(tree, { ...wallet, diamonds: 0 })).toBe(false);
    expect(canBuy({ ...tree, repeatable: false }, wallet)).toBe(false);
  });

  it('营地商店过滤已经拥有的可重复物件，保留未购商品的延迟加载图片', async () => {
    const request = vi.fn().mockResolvedValue({ items: [tree, book], page: 1, total: 1, camp_categories: ['nature'], wallet });
    render(<ShopPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    fireEvent.click(screen.getByRole('tab', { name: content.shopCamp }));
    expect(await screen.findByRole('button', { name: `${content.buy} ${book.name}` })).toBeEnabled();
    expect(screen.queryByRole('button', { name: `${content.buy} ${tree.name}` })).not.toBeInTheDocument();
    expect(screen.getByRole('article').querySelector('.shop-product-art')).toHaveAttribute('loading', 'lazy');
  });
});
