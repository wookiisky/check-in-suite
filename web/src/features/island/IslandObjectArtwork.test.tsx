import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IslandObjectArtwork, supportsObjectArtwork } from './IslandObjectArtwork';

describe('小岛物件的局部动画部件', () => {
  it.each([
    ['windmill', '.island-windmill-blades'],
    ['fountain', '.island-fountain-water'],
    ['swing', '.island-swing-seat'],
    ['lantern', '.island-lantern-flame'],
    ['flowers', '.island-flowers-stems'],
  ])('%s保留原素材坐标，并将运动部件与底座分开', (key, selector) => {
    const model = `island-${key}-v1`;
    expect(supportsObjectArtwork(model)).toBe(true);
    const { container } = render(<svg><IslandObjectArtwork model={model} /></svg>);
    const root = container.querySelector('.island-object-art');
    expect(root).toHaveAttribute('transform', 'translate(-60 -99.375) scale(.375)');
    const moving = root!.querySelector(selector)!;
    const base = root!.querySelector('.island-object-base')!;
    expect(moving).not.toBeNull();
    expect(base).not.toBeNull();
    expect(moving.contains(base)).toBe(false);
    expect(base.contains(moving)).toBe(false);
    expect(root!.querySelector('image')).toBeNull();
  });

  it('不声明其他静态物件的分部件能力', () => {
    expect(supportsObjectArtwork('island-rocks-v1')).toBe(false);
    expect(supportsObjectArtwork('unknown')).toBe(false);
  });

  it('多实例不产生重复的SVG资源身份', () => {
    const { container } = render(<svg><IslandObjectArtwork model="island-lantern-v1" /><IslandObjectArtwork model="island-lantern-v1" /></svg>);
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
