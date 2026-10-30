import resourceCatalog from '../../../../internal/island/catalog.json';
import { familyHomePlacements, familyFurniturePositions } from '../../../e2e/housing-furniture-fixtures';
import { describe, expect, it } from 'vitest';
import { canPlace, clampPlacement, findPath, isWalkable, project, projectInterior, unprojectInterior } from './island-geometry';
import { definitions, state } from './island-test-fixtures';
import type { IslandDefinition, IslandPlacement } from './island-types';

const furniture: IslandDefinition = { key: 'chair', name: '餐椅', model: 'island-dining-chair-v1', category: 'decoration', width: 0.7, depth: 0.7, movable: true, repeatable: true, indoor_only: true };
const catalog = [...definitions, furniture];
const chair: IslandPlacement = { id: 'chair-1', item_key: 'chair', x: -3.5, y: 2.5, rotation: 0, zone: 'indoor' };

describe('家庭房屋的真实可用空间', () => {
  it('房屋外轮廓为凸窗和门廊保留占地，装饰不能插进屋檐范围', () => {
    const home = { ...definitions[0]!, width: 13, depth: 9 };
    const catalog = [home, ...definitions.slice(1)];
    expect(canPlace(state.placements[0]!, state.placements, catalog)).toBe(true);
    expect(canPlace(state.placements[2]!, state.placements, catalog)).toBe(true);
    const tree: IslandPlacement = { id: 'tree-1', item_key: 'tree', x: 4.5, y: -2, rotation: 0, zone: 'outdoor' };
    expect(canPlace(tree, state.placements, catalog)).toBe(false);
    expect(canPlace({ ...tree, x: 6.25 }, state.placements, catalog)).toBe(true);
    expect(findPath({ x: 0, y: 4 }, { x: -1.5, y: 3.1 }, state.placements, catalog).length).toBeGreaterThan(0);
  });
  it('加宽的生活区和卫生间能摆新物件，人物不能越过外墙', () => {
    expect(canPlace({ ...chair, x: -5.5, y: 2 }, [], catalog)).toBe(true);
    expect(canPlace({ ...chair, x: 5.5, y: -2.5 }, [], catalog)).toBe(true);
    expect(isWalkable({ x: -5.5, y: 2 }, [], catalog, 'indoor')).toBe(true);
    expect(isWalkable({ x: 6, y: 2 }, [], catalog, 'indoor')).toBe(false);
  });

  it('整套家具同时摆放后书桌与卫生间仍可到达', () => {
    const owned = familyFurniturePositions.map((item, index) => ({ id: `furniture-${index}`, item_key: item.item_key }));
    const placements = familyHomePlacements(owned);
    const definitions = resourceCatalog as IslandDefinition[];
    for (const placement of placements) expect(canPlace(placement, placements, definitions), placement.item_key).toBe(true);
    const start = { x: 0, y: 3.5 };
    expect(findPath(start, { x: -0.75, y: 0.8 }, placements, definitions, 'indoor').length).toBeGreaterThan(0);
    expect(findPath(start, { x: 3.5, y: -1.75 }, placements, definitions, 'indoor').length).toBeGreaterThan(0);
  });

  it('新扩区域可摆家具，完整占地仍不能越过外墙', () => {
    expect(canPlace(chair, state.placements, catalog)).toBe(true);
    expect(canPlace({ ...chair, x: 6 }, state.placements, catalog)).toBe(false);
    expect(clampPlacement({ ...chair, x: 8, y: 7 }, furniture)).toMatchObject({ x: 5.5, y: 3.5 });
    expect(canPlace({ ...chair, zone: 'outdoor', x: 6, y: -5 }, state.placements, catalog)).toBe(false);
  });
  it('不能跨越卫生间隔墙，也不能堵住卫生间或房屋入口', () => {
    for (const point of [{ x: 2.25, y: -2.5 }, { x: 2.5, y: -1 }, { x: 4.75, y: -1 }, { x: 3.5, y: -1 }, { x: 0, y: 3.5 }]) {
      expect(canPlace({ ...chair, ...point }, [], catalog)).toBe(false);
    }
    expect(canPlace({ ...chair, x: 4, y: -3 }, [], catalog)).toBe(true);
  });
  it('完整卫生间物件可以从门洞到达，人物不能横穿隔墙', () => {
    const start = { x: 0, y: 3.5 };
    const end = { x: 4, y: -2.5 };
    const path = findPath(start, end, [], catalog, 'indoor');
    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toEqual(end);
    expect(path.some((point) => point.y === -1 && point.x > 3 && point.x < 4.25)).toBe(true);
    expect(path.every((point) => isWalkable(point, [], catalog, 'indoor'))).toBe(true);
    expect(isWalkable({ x: 2.25, y: -2.5 }, [], catalog, 'indoor')).toBe(false);
  });
  it('室内统一地面单位并可在放大后往返投影', () => {
    const house = state.placements[0]!;
    const home = { ...definitions[0]!, width: 13, depth: 9 };
    const center = project(house);
    for (const point of [{ x: -6, y: -4 }, { x: 6, y: 4 }, { x: 4, y: -3 }, { x: 0, y: 3.5 }]) {
      const screen = projectInterior(point, house, home);
      expect(screen.x - center.x).toBeCloseTo((point.x - point.y) * 24);
      expect(screen.y - center.y).toBeCloseTo((point.x + point.y) * 12);
      expect(unprojectInterior(screen, house, home)).toEqual(point);
    }
  });
});
