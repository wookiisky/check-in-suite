import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import { ShopPage } from './ShopPage';
import { camp, product, purchase } from './test-fixtures';
import content from './content.json';
import type { Product, SceneOption } from './types';

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

describe('场景商店', () => {
  it('场景分类查询独立商品类型，购买后说明解锁空间而非装备人物', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/purchases') return { purchase: { ...purchase, type_snapshot: 'scene', scene_key: forest.scene_key }, wallet: camp.wallet };
      return { items: [sceneProduct], page: 1, total: 1, camp_categories: ['scene'], wallet: camp.wallet };
    });
    render(<ShopPage client={{ request }} session={session} initialGroup="scene" />);
    await screen.findByRole('heading', { name: forest.name });
    expect(screen.getByRole('tab', { name: content.categoryGroups.scene })).toHaveAttribute('aria-selected', 'true');
    expect(request.mock.calls.some(([path]) => new URL(path, 'http://fixture').searchParams.get('category') === 'scene')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `${content.buy} ${forest.name}` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.scenePurchased);
    expect(screen.queryByText(content.purchaseSuccess)).not.toBeInTheDocument();
  });
});
