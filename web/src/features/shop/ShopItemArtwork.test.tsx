import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShopItemArtwork } from './ShopItemArtwork';
import { product, purchase } from './test-fixtures';

describe('商品缩略图', () => {
  it('服装直接显示模型生成缩略图，并保留可访问名称', () => {
    const wearable = { ...product, type: 'wearable', asset_key: 'arbitrary-thumbnail', wearable_key: 'not-a-slot' };
    render(<ShopItemArtwork item={wearable} label="服装预览" />);
    expect(screen.getByRole('img', { name: '服装预览' })).toHaveAttribute('src', '/api/v1/assets/arbitrary-thumbnail');
  });

  it('历史成交缩略图采用订单快照，装饰图片保留空alt', () => {
    const { container } = render(<ShopItemArtwork item={{ ...purchase, asset_key_snapshot: 'saved-thumbnail' }} />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/v1/assets/saved-thumbnail');
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });
});
