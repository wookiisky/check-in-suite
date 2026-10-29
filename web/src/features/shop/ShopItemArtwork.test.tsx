import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShopItemArtwork } from './ShopItemArtwork';
import { product } from './test-fixtures';

describe('穿戴商品缩略图', () => {
  it('长发前后层同时显示，并为商品图保留完整可访问名称', () => {
    const { container } = render(<ShopItemArtwork item={{ ...product, asset_key: 'hair-long-v1', wearable_slot: 'hair', back_asset_key: 'hair-long-back-v1' }} label="长发" />);
    expect(screen.getByRole('img', { name: '长发' })).toBeInTheDocument();
    expect([...container.querySelectorAll('image')].map((image) => image.getAttribute('href'))).toEqual([
      '/api/v1/assets/hair-long-back-v1', '/api/v1/assets/hair-long-v1',
    ]);
  });

  it('普通商品继续显示原图片，固定特效缩略图使用静态素材', () => {
    render(<ShopItemArtwork item={{ ...product, type: 'effect', asset_key: 'effect-snow-v1' }} label="雪花" />);
    expect(screen.getByRole('img', { name: '雪花' })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
  });
});
