import { describe, expect, it } from 'vitest';
import { itemCategory, matchesAssetCategory } from './shop-categories';
import { product } from './test-fixtures';
import { appearanceFixture } from './appearance-test-fixtures';

describe('商品目录分类', () => {
  it('新增人物只使用当前定义的缩略图，历史资源不重新成为可选人物', () => {
    const current = { ...appearanceFixture().characters[0]!, thumbnail_asset_key: 'current-character-thumb', thumbnail_url: '/current-character.png' };
    const characters = [current];
    const artwork = { key: current.thumbnail_asset_key, kind: 'character' as const, name: current.name, url: current.thumbnail_url };
    expect(matchesAssetCategory(artwork, 'character', [], characters)).toBe(true);
    expect(matchesAssetCategory({ ...artwork, key: 'retained-historical-character-thumb' }, 'character', [], characters)).toBe(false);
    expect(matchesAssetCategory({ ...artwork, free: true }, 'character', [], characters)).toBe(false);
  });

  it('按服装定义的槽位分类，名称和稳定 key 不参与判断', () => {
    const definitions = appearanceFixture().wearables.map((item) => ({ ...item, name: '与部位无关的名称', wearable_key: `arbitrary-${item.wearable_key.length}-${item.slot}` }));
    const definition = definitions.find((item) => item.slot === 'upper')!;
    const garment = { ...product, type: 'wearable' as const, wearable_key: definition.wearable_key };
    expect(itemCategory(garment, definitions)).toBe('upper');
    expect(itemCategory({ ...garment, wearable_key: 'unknown-upper' }, definitions)).toBeNull();
    expect(itemCategory({ ...product, type: 'island' }, definitions)).toBe('island');
  });
});
