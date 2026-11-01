import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import { ShopPage } from './ShopPage';
import { BackpackPage } from './BackpackPage';
import { ProductEditor } from './ProductEditor';
import { camp, product, purchase } from './test-fixtures';
import content from './content.json';
import type { Asset, Product, SceneOption } from './types';

vi.mock('../character/AppearanceProvider', async () => {
  const { appearanceFixture } = await import('./appearance-test-fixtures');
  return { useAppearance: () => ({ snapshot: appearanceFixture(), loading: false, error: null, refresh: vi.fn() }) };
});

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };
const forest: SceneOption = {
  scene_key: 'forest-courtyard-v1', name: '林间场景', thumbnail_asset_key: 'forest-thumb', thumbnail_url: '/forest.png',
  free: false, owned: false, default_environment: 'day',
  scene: { scene_key: 'forest-courtyard-v1', regions: [], environments: ['day'], house: null, activity_presentations: {} },
};
const sceneProduct: Product = { ...product, id: 'scene-offer', type: 'scene', scene_key: forest.scene_key, asset_key: forest.thumbnail_asset_key, name: forest.name, coin_price: 0, diamond_price: 0 };
const artwork: Asset = { key: forest.thumbnail_asset_key, name: forest.name, kind: 'scene', url: forest.thumbnail_url };

describe('场景商店与背包', () => {
  it('场景分类查询独立商品类型，购买后说明解锁空间而非装备人物', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path === '/purchases') return { purchase: { ...purchase, type_snapshot: 'scene', scene_key: forest.scene_key }, wallet: camp.wallet };
      return { items: [sceneProduct], next_cursor: null };
    });
    render(<ShopPage client={{ request }} session={session} initialGroup="scene" />);
    await screen.findByRole('heading', { name: forest.name });
    expect(screen.getByRole('tab', { name: content.categoryGroups.scene })).toHaveAttribute('aria-selected', 'true');
    expect(request.mock.calls.some(([path]) => new URL(path, 'http://fixture').searchParams.get('type') === 'scene')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${forest.name}` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.scenePurchased);
    expect(screen.queryByText(content.purchaseSuccess)).not.toBeInTheDocument();
  });

  it('背包场景分类读取永久资格，并把目标身份传给营地入口', async () => {
    const request = vi.fn().mockImplementation(async () => ({ items: [{ ...purchase, type_snapshot: 'scene', scene_key: forest.scene_key, name_snapshot: forest.name }], next_cursor: null }));
    const onIsland = vi.fn();
    render(<BackpackPage client={{ request }} session={session} onBack={vi.fn()} onAppearance={vi.fn()} onIsland={onIsland} />);
    fireEvent.click(screen.getByRole('tab', { name: content.categoryGroups.scene }));
    fireEvent.click(await screen.findByRole('button', { name: `${content.enterScene} ${forest.name}` }));
    expect(onIsland).toHaveBeenCalledWith(forest.scene_key);
    const path = String(request.mock.calls.at(-1)?.[0]);
    expect(new URL(path, 'http://fixture').searchParams.get('type')).toBe('scene');
  });

  it('管理编辑保留场景身份，新增只从场景目录选择且切换类型清除身份', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/island/scenes' ? { items: [forest, { ...forest, scene_key: 'seaside-v1', free: true, thumbnail_asset_key: 'free-thumb' }] } : sceneProduct);
    const view = render(<ProductEditor client={{ request }} session={session} product={sceneProduct} assets={[artwork]} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: forest.name });
    fireEvent.change(screen.getByLabelText(content.coinPrice), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request.mock.calls.some(([path, options]) => path === `/management/products/${sceneProduct.id}` && options?.body?.scene_key === forest.scene_key)).toBe(true));
    view.unmount();
    request.mockClear();
    render(<ProductEditor client={{ request }} session={session} product={null} assets={[artwork, { ...artwork, key: 'unregistered-thumb', name: '未登记场景' }, { ...artwork, key: 'reward-thumb', kind: 'reward', name: '奖励' }]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'scene' } });
    await screen.findByRole('option', { name: forest.name });
    expect(screen.queryByRole('option', { name: '未登记场景' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.asset), { target: { value: artwork.key } });
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: forest.name } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request.mock.calls.some(([path, options]) => path === '/management/products' && options?.body?.scene_key === forest.scene_key)).toBe(true));
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'reward' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/management/products')).toHaveLength(2));
    expect(request.mock.calls.at(-1)?.[1]?.body?.scene_key).toBeUndefined();
  });

  it('场景目录失败时保留表单并禁用新增，重读后恢复选择', async () => {
    let reads = 0;
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/island/scenes') {
        reads += 1;
        if (reads === 1) throw new TypeError('offline');
        return { items: [forest] };
      }
      return sceneProduct;
    });
    render(<ProductEditor client={{ request }} session={session} product={null} assets={[artwork]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: forest.name } });
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'scene' } });
    const retry = await screen.findByRole('button', { name: content.sceneCatalogRetry });
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    expect(screen.getByLabelText(content.name)).toHaveValue(forest.name);
    fireEvent.click(retry);
    await screen.findByRole('option', { name: forest.name });
    fireEvent.change(screen.getByLabelText(content.asset), { target: { value: artwork.key } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request.mock.calls.some(([path, options]) => path === '/management/products' && options?.body?.scene_key === forest.scene_key)).toBe(true));
  });
});
