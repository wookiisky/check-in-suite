import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FurnitureArtwork, supportsFurnitureArtwork } from './FurnitureArtwork';

describe('家具透明边界', () => {
  it.each(['bed', 'dining-table', 'dining-chair', 'sofa', 'coffee-table', 'television', 'cabinet', 'refrigerator', 'kitchen-counter', 'toilet', 'washbasin', 'shower'])('%s以原生形状接受点击，透明图片范围和阴影不拦截其他物件', (key) => {
    const model = `island-${key}-v1`;
    expect(supportsFurnitureArtwork(model)).toBe(true);
    const { container } = render(<svg><FurnitureArtwork model={model} /></svg>);
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('polygon')).not.toBeNull();
    expect(container.querySelector('ellipse')).toHaveAttribute('pointer-events', 'none');
    expect(container.querySelector('[data-furniture-model]')).toHaveAttribute('fill', 'none');
  });

  it('未知模型交由已有渲染器处理', () => {
    expect(supportsFurnitureArtwork('island-tree-v1')).toBe(false);
    const { container } = render(<svg><FurnitureArtwork model="island-tree-v1" /></svg>);
    expect(container.querySelector('[data-furniture-model]')).toBeNull();
  });
});
