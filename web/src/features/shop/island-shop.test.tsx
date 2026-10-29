import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShopPage } from './ShopPage';
import { CharacterPanel } from './CharacterPanel';
import { canBuy } from './helpers';
import { camp, product, purchase, wallet } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

// 双用途与重复购买测试数据不改变正式物品定义。
const tree = { ...product, id: 'tree', type: 'island' as const, name: '小岛树木', island_item_key: 'tree', repeatable: true, owned: true, owned_count: 2 };
const book = { ...product, id: 'book', name: '双用途书本', island_item_key: 'book' };
const treePurchase = { ...purchase, id: 'tree-owned', type_snapshot: 'island' as const, island_item_key: 'tree', name_snapshot: tree.name };
const bookPurchase = { ...purchase, id: 'book-owned', island_item_key: 'book', name_snapshot: book.name };

describe('小岛商店与多件所有权', () => {
  it('已拥有的可重复物品仍可购买，库存和双币条件继续生效', () => {
    expect(canBuy(tree, wallet)).toBe(true);
    expect(canBuy({ ...tree, stock: 0 }, wallet)).toBe(false);
    expect(canBuy(tree, { ...wallet, diamonds: 0 })).toBe(false);
    expect(canBuy({ ...tree, repeatable: false }, wallet)).toBe(false);
  });

  it('小岛建设包含双用途商品，购买后进入小岛物品且不自动装备', async () => {
    const onIsland = vi.fn();
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [tree, book, product] };
      if (path === '/purchases') return { purchase: treePurchase, wallet };
      if (path.startsWith('/purchases?')) return { items: [treePurchase], next_cursor: null };
      throw new Error(`Unexpected request ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} onIsland={onIsland} />);
    fireEvent.click(screen.getByRole('button', { name: content.construction }));
    await screen.findByRole('button', { name: `${content.buy} ${tree.name}` });
    expect(screen.getByRole('button', { name: `${content.buy} ${book.name}` })).toBeEnabled();
    expect(screen.queryByRole('button', { name: `${content.buy} ${product.name}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${tree.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByRole('button', { name: content.goToIsland });
    expect(screen.getByRole('button', { name: content.islandInventory })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: content.goToIsland }));
    expect(onIsland).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment'))).toBe(false);
  });

  it('小岛专用品不进入衣柜，双用途物品仍能佩戴', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?')) return { items: [treePurchase, bookPurchase], next_cursor: null };
      return {};
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    await screen.findByRole('button', { name: `${content.equip} ${book.name}` });
    expect(screen.queryByRole('button', { name: `${content.equip} ${tree.name}` })).not.toBeInTheDocument();
  });

  it('过滤后的第一页没有岛屿物品时保留翻页，不误报空库存', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [] };
      if (path.includes('cursor=')) return { items: [treePurchase], next_cursor: null };
      return { items: [purchase], next_cursor: 'next' };
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.islandInventory }));
    const more = await screen.findByRole('button', { name: content.more });
    expect(screen.queryByText(content.emptyPurchases)).not.toBeInTheDocument();
    fireEvent.click(more);
    await screen.findByText(tree.name);
  });
  it('岛屿成交物品追加画像能力后可被饰品筛选找到并调用饰品装备接口', async () => {
    const portrait = { ...treePurchase, portrait_type: 'accessory' as const, portrait_asset_key: 'accessory-leaf-v1' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/products') return { items: [] };
      if (path.startsWith('/purchases?status=owned')) return { items: [portrait], next_cursor: null };
      if (path === `/equipment/accessories/${portrait.id}`) return {};
      throw new Error(`Unexpected request ${path}`);
    });
    render(<ShopPage client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.wardrobe }));
    fireEvent.change(screen.getByRole('combobox', { name: content.typeFilter }), { target: { value: 'accessory' } });
    const equip = await screen.findByRole('button', { name: `${content.equip} ${portrait.name_snapshot}` });
    expect(screen.getByRole('img', { name: content.baseAvatarNames['avatar-boy-v2'] })).toHaveAttribute('data-base-avatar', 'avatar-boy-v2');
    fireEvent.click(equip);
    await screen.findByText(content.equipmentSaved);
    expect(request).toHaveBeenCalledWith(`/equipment/accessories/${portrait.id}`, { method: 'PUT' });
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/equipment/island'))).toBe(false);
  });

  it('画像画布使用后追加的画像素材，购买时的小岛缩略图保持成交记录用途', () => {
    const portrait = { ...treePurchase, portrait_type: 'accessory' as const, portrait_asset_key: 'accessory-leaf-v1' };
    const title = { ...treePurchase, id: 'title', portrait_type: 'title' as const, portrait_asset_key: 'title-crown-v1' };
    const equipped = { ...camp.equipment, title, accessories: [portrait], accessory_layouts: { [portrait.id]: { x: 0.5, y: 0.5, size: 0.2, layer: 1 } } };
    const { container } = render(<CharacterPanel equipment={equipped} displayName="测试角色" />);
    expect(container.querySelector('.shop-accessory-art')).toHaveAttribute('src', '/api/v1/assets/accessory-leaf-v1');
    expect(container.querySelector('.shop-character-title img')).toHaveAttribute('src', '/api/v1/assets/title-crown-v1');
  });

});
