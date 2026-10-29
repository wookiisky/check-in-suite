import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SeasideArtwork, SceneSky } from './SeasideArtwork';
import { IslandScene } from './IslandScene';
import { defaultScene } from './scene-definitions';
import { defaultPresentation } from './scene-presentation';
import { terrainAt } from './scene-terrain';
import { createActor } from './island-activity';
import { state } from './island-test-fixtures';

describe('海边整体场景', () => {
  it('绘制地形直接取自场景定义，天空不参与地面变换', () => {
    const { container } = render(<svg><SceneSky width={1000} height={760} scene={defaultScene} staticMotion={false} motionPaused={false}/><SeasideArtwork scene={defaultScene} staticMotion={false} motionPaused={false}/></svg>);
    expect(container.querySelectorAll('[data-terrain]')).toHaveLength(defaultScene.terrain.length);
    expect(container.querySelector('.scene-sky')).not.toBeNull();
    expect(container.querySelector('.seaside-shore-wave')).not.toBeNull();
    expect(container.querySelector('.scene-cloud-drift')).not.toBeNull();
    expect(terrainAt(defaultScene.terrain, { x: -8, y: -8 })).not.toBe('water');
  });

  it('换入另一份定义时，地形、背景身份和默认取景一起更新，物品坐标保持不变', () => {
    const props = { insets: { top: 100, right: 0, bottom: 140, left: 0 }, placements: state.placements, catalog: state.catalog, actor: createActor(), avatar: 'fox-v1', editing: false, indoor: false, selected: null, staticMotion: false, onSelect: vi.fn(), onMove: vi.fn(), onActivity: vi.fn(), onBlocked: vi.fn() };
    const { container, rerender } = render(<IslandScene {...props}/>);
    const placement = container.querySelector('[data-placement-id="base:house"]')!.getAttribute('transform');
    const house = container.querySelector('[data-placement-id="base:house"]')!;
    const sky = container.querySelector('.scene-sky')!;
    expect(sky.compareDocumentPosition(house) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const pan = container.querySelector('.island-scene')!.getAttribute('data-pan-x');
    const alternate = { ...defaultScene, key: 'test-coast', camera: { ...defaultScene.camera, center: { x: 420, y: 180 } }, terrain: [{ kind: 'sand' as const, polygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] }] };
    rerender(<IslandScene {...props} scene={{ ...defaultPresentation, definition: alternate }}/>);
    expect(container.querySelector('[data-scene-key]')).toHaveAttribute('data-scene-key', alternate.key);
    expect(container.querySelectorAll('[data-terrain]')).toHaveLength(1);
    expect(container.querySelector('.island-scene')!.getAttribute('data-pan-x')).not.toBe(pan);
    expect(container.querySelector('[data-placement-id="base:house"]')).toHaveAttribute('transform', placement!);
    expect(terrainAt(alternate.terrain, { x: 0, y: 0 })).toBe('sand');
    // 整体入口也能换掉渲染器，而不只是在海边背景上换一份地形数据。
    rerender(<IslandScene {...props} scene={{ definition: alternate, Ground: () => <g data-testid="alternate-ground"/>, Sky: () => <g data-testid="alternate-sky"/> }}/>);
    expect(container.querySelector('[data-testid="alternate-ground"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="alternate-sky"]')).not.toBeNull();
    expect(container.querySelector('.seaside-art')).toBeNull();
    expect(container.querySelector('[data-placement-id="base:house"]')).toHaveAttribute('transform', placement!);
  });
});
