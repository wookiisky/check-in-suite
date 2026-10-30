import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CharacterArtwork, ItemArtwork } from './IslandArtwork';

describe('补充素材的场景展示', () => {
  it('选中轮廓随房屋占地扩展且不会截获附近物品的点击', () => {
    const footprint = { width: 13, depth: 9 };
    const { container } = render(<svg><ItemArtwork model="house" selected footprint={footprint} /></svg>);
    const outline = container.querySelector('.island-item-art > ellipse');
    expect(Number(outline?.getAttribute('rx'))).toBeGreaterThan((footprint.width + footprint.depth) * 12);
    expect(Number(outline?.getAttribute('ry'))).toBeGreaterThan((footprint.width + footprint.depth) * 6);
    expect(outline).toHaveAttribute('pointer-events', 'none');
  });

  it('新家具按统一地面锚点绘制，横向镜像只对应交换长宽的朝向', () => {
    const { container, rerender } = render(<svg><ItemArtwork model="island-bed-v1" furniture rotation={90} /></svg>);
    const shape = container.querySelector('[data-furniture-model]');
    expect(container.querySelector('image')).toBeNull();
    expect(shape).not.toBeNull();
    expect(shape?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    rerender(<svg><ItemArtwork model="island-bed-v1" furniture rotation={180} /></svg>);
    expect(container.querySelector('[data-furniture-model]')?.parentElement).toHaveAttribute('transform', 'scale(1 1)');
  });

  it.each(['mushrooms', 'rocks', 'fence', 'bench', 'tent'])('实际绘制 %s 的受控图片并保留镜像方向', (key) => {
    const model = `island-${key}-v1`;
    const { container } = render(<svg><ItemArtwork model={model} rotation={180} selected staticMotion /></svg>);
    const image = container.querySelector('image');
    expect(image).toHaveAttribute('href', `/api/v1/assets/${model}`);
    expect(image?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    expect(container.querySelector('.island-item-art')).toHaveAttribute('data-static', 'true');
  });

  it.each(['flowers', 'lantern', 'fountain', 'swing', 'windmill'])('%s使用局部模型，未声明动画时仍完整显示且支持镜像', (key) => {
    const { container } = render(<svg><ItemArtwork model={`island-${key}-v1`} rotation={180} selected /></svg>);
    expect(container.querySelector('image')).toBeNull();
    const artwork = container.querySelector('.island-object-art');
    expect(artwork).not.toBeNull();
    expect(artwork?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    expect(container.querySelector('.island-item-art')).not.toHaveAttribute('data-animation');
    expect(container.querySelector('.island-object-base')).not.toBeNull();
  });

  it.each(['bear-v1', 'cat-v1', 'deer-v1', 'red-panda-v1'])('佩戴 %s 时小岛显示同一角色', (avatar) => {
    const { container } = render(<svg><CharacterArtwork avatar={avatar} moving activity="read" facing={-1} staticMotion /></svg>);
    expect(container.querySelector('image')).toHaveAttribute('href', `/api/v1/assets/${avatar}`);
    expect(container.querySelector('.island-character-image-body')?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    expect(container.querySelector('.island-character-art')).toHaveAttribute('data-activity', 'read');
  });

  it.each(['bear-v1', 'avatar-boy-v2', 'avatar-girl-v2'])('图片角色 %s 共用动作时钟并保留减少动效的活动道具', (avatar) => {
    const { container, rerender } = render(<svg><CharacterArtwork avatar={avatar} moving={false} activity="read" motionElapsed={2.25} staticMotion /></svg>);
    expect(container.querySelector('.island-character-art')).toHaveStyle({ '--island-motion-delay': '-2.25s' });
    expect(container.querySelector('.island-character-image-body [data-character-layer="body"], .island-character-image-body > image')).toHaveAttribute('href', `/api/v1/assets/${avatar}`);
    expect(container.querySelector('.island-character-book')).not.toBeNull();
    expect(container.querySelector('.island-character-art')).toHaveAttribute('data-static', 'true');
    rerender(<svg><CharacterArtwork avatar={avatar} moving={false} activity="ball" motionElapsed={2.5} staticMotion /></svg>);
    expect(container.querySelector('.island-character-ball')).not.toBeNull();
    expect(container.querySelector('.island-character-book')).toBeNull();
  });

  it.each(['fox', 'bunny'])('已有 %s 继续使用肢体动画绘制', (avatar) => {
    const { container } = render(<svg><CharacterArtwork avatar={avatar} moving activity="walk" /></svg>);
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('.island-character-leg')).not.toBeNull();
  });
});
