import { describe, expect, it } from 'vitest';
import type { IslandPoint } from './island-types';
import { canOccupyTerrain, terrainAt, type TerrainRegion } from './scene-terrain';
import { defaultScene, seasideScene } from './scene-definitions';

// 测试占地使用真实世界坐标，不依赖 SVG 显示比例。
function rectangle(left: number, top: number, right: number, bottom: number): IslandPoint[] {
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

const dividedTerrain: TerrainRegion[] = [
  { kind: 'water', polygon: rectangle(-10, -10, 0, 10) },
  { kind: 'sand', polygon: rectangle(0, -10, 3, 10) },
  { kind: 'grass', polygon: rectangle(3, -10, 10, 10) },
];

describe('场景地形与完整占地', () => {
  it('查询实际地形，共用边界归于先声明区域，场景外没有可布置地形', () => {
    expect(terrainAt(dividedTerrain, { x: -5, y: 0 })).toBe('water');
    expect(terrainAt(dividedTerrain, { x: 1, y: 0 })).toBe('sand');
    expect(terrainAt(dividedTerrain, { x: 6, y: 0 })).toBe('grass');
    expect(terrainAt(dividedTerrain, { x: 0, y: 0 })).toBe('water');
    expect(terrainAt(dividedTerrain, { x: 11, y: 0 })).toBeNull();
  });

  it('水域允许完整占地及沿边摆放，跨岸或超出有限场景时拒绝', () => {
    expect(canOccupyTerrain(dividedTerrain, rectangle(-8, -2, -2, 2), ['water'])).toBe(true);
    expect(canOccupyTerrain(dividedTerrain, rectangle(-8, -2, 0, 2), ['water'])).toBe(true);
    expect(canOccupyTerrain(dividedTerrain, rectangle(-1, -2, 1, 2), ['water'])).toBe(false);
    expect(canOccupyTerrain(dividedTerrain, rectangle(-12, -2, -8, 2), ['water'])).toBe(false);
  });

  it('占地可以横跨相邻的多种允许地形，不要求被单块区域完全包住', () => {
    expect(canOccupyTerrain(dividedTerrain, rectangle(1, -2, 7, 2), ['grass', 'sand'])).toBe(true);
    expect(canOccupyTerrain(dividedTerrain, rectangle(1, -2, 7, 2), ['grass'])).toBe(false);
    expect(canOccupyTerrain(dividedTerrain, rectangle(1, -2, 7, 2), [])).toBe(false);
  });

  it('凹形岸线即使四角都合法，边穿过海湾仍不能布置', () => {
    const bay: TerrainRegion[] = [{ kind: 'grass', polygon: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 7, y: 10 },
      { x: 7, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 10 }, { x: 0, y: 10 },
    ] }];
    const crossing = rectangle(1, 1, 9, 9);
    expect(crossing.every((point) => terrainAt(bay, point) === 'grass')).toBe(true);
    expect(canOccupyTerrain(bay, crossing, ['grass'])).toBe(false);
    expect(canOccupyTerrain(bay, rectangle(0, 0, 10, 3), ['grass'])).toBe(true);
  });

  it('整个边框合法但内部有不可用区域时也拒绝', () => {
    const ring: TerrainRegion[] = [
      { kind: 'grass', polygon: rectangle(0, 0, 10, 3) },
      { kind: 'grass', polygon: rectangle(0, 7, 10, 10) },
      { kind: 'grass', polygon: rectangle(0, 3, 3, 7) },
      { kind: 'grass', polygon: rectangle(7, 3, 10, 7) },
    ];
    expect(canOccupyTerrain(ring, rectangle(1, 1, 9, 9), ['grass'])).toBe(false);
  });

  it('同类重叠区域按并集判断，并拒绝空占地与没有面积的占地', () => {
    const overlap: TerrainRegion[] = [
      { kind: 'grass', polygon: rectangle(0, 0, 6, 6) },
      { kind: 'grass', polygon: rectangle(3, 0, 9, 6) },
    ];
    expect(canOccupyTerrain(overlap, rectangle(4, 1, 8, 5), ['grass'])).toBe(true);
    expect(canOccupyTerrain(overlap, [], ['grass'])).toBe(false);
    expect(canOccupyTerrain(overlap, rectangle(1, 1, 1, 3), ['grass'])).toBe(false);
  });
});

describe('默认海边场景的数据兼容', () => {
  it('全部旧室外范围仍是陆地，默认房屋及运动区不需要迁移', () => {
    expect(defaultScene).toBe(seasideScene);
    expect(canOccupyTerrain(seasideScene.terrain, rectangle(-8, -8, 8, 8), ['grass', 'sand'])).toBe(true);
    expect(canOccupyTerrain(seasideScene.terrain, rectangle(-7, -5, 1, 1), ['grass', 'sand'])).toBe(true);
    expect(canOccupyTerrain(seasideScene.terrain, rectangle(2, 1, 4, 3), ['grass', 'sand'])).toBe(true);
  });

  it('岸线两侧有明确的沙滩和水域，远景之外不算可布置水域', () => {
    const shore = seasideScene.shoreline[Math.floor(seasideScene.shoreline.length / 2)]!;
    expect(terrainAt(seasideScene.terrain, { x: shore.x - 1, y: shore.y - 1 })).toBe('water');
    expect(terrainAt(seasideScene.terrain, { x: shore.x + 1, y: shore.y + 1 })).toBe('sand');
    expect(terrainAt(seasideScene.terrain, { x: -150, y: -150 })).toBeNull();
    expect(seasideScene.shoreline[0]!.x - seasideScene.shoreline[0]!.y).toBe(-100);
    expect(seasideScene.shoreline.at(-1)!.x - seasideScene.shoreline.at(-1)!.y).toBe(100);
  });
});
