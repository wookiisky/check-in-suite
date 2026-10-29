import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CharacterArtwork, ItemArtwork } from './IslandArtwork';

describe('补充素材的场景展示', () => {
  it.each(['flowers', 'mushrooms', 'rocks', 'fence', 'bench', 'lantern', 'tent', 'fountain', 'swing', 'windmill'])('实际绘制 %s 的受控图片并保留镜像方向', (key) => {
    const model = `island-${key}-v1`;
    const { container } = render(<svg><ItemArtwork model={model} rotation={180} selected staticMotion /></svg>);
    const image = container.querySelector('image');
    expect(image).toHaveAttribute('href', `/api/v1/assets/${model}`);
    expect(image?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    expect(container.querySelector('.island-item-art')).toHaveAttribute('data-static', 'true');
  });

  it.each(['bear-v1', 'cat-v1', 'deer-v1', 'red-panda-v1'])('佩戴 %s 时小岛显示同一角色', (avatar) => {
    const { container } = render(<svg><CharacterArtwork avatar={avatar} moving activity="read" facing={-1} staticMotion /></svg>);
    expect(container.querySelector('image')).toHaveAttribute('href', `/api/v1/assets/${avatar}`);
    expect(container.querySelector('image')?.parentElement).toHaveAttribute('transform', 'scale(-1 1)');
    expect(container.querySelector('.island-character-art')).toHaveAttribute('data-activity', 'read');
  });

  it.each(['fox', 'bunny'])('已有 %s 继续使用肢体动画绘制', (avatar) => {
    const { container } = render(<svg><CharacterArtwork avatar={avatar} moving activity="walk" /></svg>);
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('.island-character-leg')).not.toBeNull();
  });
});
