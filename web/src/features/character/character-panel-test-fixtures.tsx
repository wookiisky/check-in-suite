import type { ComponentProps } from 'react';
import type { components } from '../../api/schema';
import { useAppearance } from './AppearanceProvider';
import type { CharacterPreview3D } from './CharacterPreview3D';
import { appearanceFixture } from '../shop/appearance-test-fixtures';

// 标题的成交信息独立于外观目录、商品当前名称和账户版本。
export const titlePurchase: components['schemas']['Purchase'] = {
  id: 'title-owned', product_id: 'title-product', type_snapshot: 'title', name_snapshot: '营地探索者',
  asset_key_snapshot: 'title-explorer-v1', description_snapshot: '', coin_price: 0, diamond_price: 0,
  status: 'owned', redeemed_at: null, version: 1, created_at: '2026-11-01T00:00:00Z',
};

// DOM 测试只观察共享快照与暂停参数；真实 WebGL 继续由浏览器验证。
export function PanelPreviewFake({ snapshot, paused }: ComponentProps<typeof CharacterPreview3D>) {
  return <output data-testid="saved-character-preview">{JSON.stringify({ snapshot, paused })}</output>;
}

// 保存发生在外观编辑器，首页应直接响应共享发布而无需重读聚合数据。
export function PublishPanelAppearance() {
  const { publishSaved, refresh } = useAppearance();
  return <><button onClick={() => publishSaved(appearanceFixture(2))}>发布外观快照</button><button onClick={() => void refresh()}>刷新外观快照</button></>;
}
