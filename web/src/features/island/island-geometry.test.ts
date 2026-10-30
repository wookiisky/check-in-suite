import { describe, expect, it } from 'vitest';
import { project, unproject, zoomAt, findPath, clampPlacement, canPlace, projectInterior, unprojectInterior, isWalkable, interactionPoint } from './island-geometry';
import { definitions, state } from './island-test-fixtures';

describe('岛屿坐标与摆放', () => {
  it('双倍房屋保留完整占地，默认器材与房门仍可使用', () => {
    const house = state.placements[0]!;
    const definition = definitions[0]!;
    expect(isWalkable({ x: 0.75, y: -2 }, state.placements, definitions)).toBe(false);
    expect(canPlace(house, state.placements, definitions)).toBe(true);
    expect(canPlace(state.placements[2]!, state.placements, definitions)).toBe(true);
    expect(isWalkable(interactionPoint(house, definition), state.placements, definitions)).toBe(true);
  });
  it('房屋室内投影适配地板且拖放逆变换保持逻辑坐标', () => {
    const house = state.placements[0]!;
    const definition = { ...definitions[0]!, width: 8, depth: 6 };
    const center = project(house);
    for (const point of [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: -1.25, y: 0.5 }, { x: 0, y: 1.5 }]) {
      const screen = projectInterior(point, house, definition);
      const restored = unprojectInterior(screen, house, definition);
      expect(restored.x).toBeCloseTo(point.x);
      expect(restored.y).toBeCloseTo(point.y);
      expect(Math.abs(screen.x - center.x)).toBeLessThanOrEqual(130);
      expect(screen.y - center.y).toBeGreaterThanOrEqual(-74);
      expect(screen.y - center.y).toBeLessThanOrEqual(48);
    }
    const old = projectInterior({ x: 1, y: -1 }, house, { ...definition, width: 4, depth: 3 });
    const enlarged = projectInterior({ x: 1, y: -1 }, house, definition);
    // 房间扩容保持家具与人物的地面单位，不再把所有坐标整体放大。
    expect(enlarged.x - center.x).toBeCloseTo(old.x - center.x);
  });

  it('固定斜俯视坐标可逆', () => {
    for (const point of [{ x: -3, y: -2 }, { x: 5.5, y: 7 }, { x: 0, y: 0 }]) {
      const actual = unproject(project(point));
      expect(actual.x).toBeCloseTo(point.x);
      expect(actual.y).toBeCloseTo(point.y);
    }
  });
  it('指针处缩放保持同一场景点，极限倍率受约束', () => {
    const before = { x: 15, y: -30, zoom: 1.2 };
    const pointer = { x: 360, y: 200 };
    const next = zoomAt(before, pointer, 2);
    expect((pointer.x - next.x) / next.zoom).toBeCloseTo((pointer.x - before.x) / before.zoom);
    expect((pointer.y - next.y) / next.zoom).toBeCloseTo((pointer.y - before.y) / before.zoom);
    expect(zoomAt(before, pointer, 100).zoom).toBe(2.5);
  });
  it('放置限制包含物品占地，而非只检查中心点', () => {
    const tree = { id: 'tree-1', item_key: 'tree', x: 8, y: -8, rotation: 0 as const, zone: 'outdoor' as const };
    expect(clampPlacement(tree, definitions[4]!)).toMatchObject({ x: 7.5, y: -7.5 });
  });
  it('四分之一格对齐不把小尺寸物品推到室内边界之外', () => {
    const item = { ...definitions[1]!, width: 0.6, depth: 0.5 };
    const result = clampPlacement({ id: 'book', item_key: 'desk', x: 6, y: 0, rotation: 0, zone: 'indoor' }, item);
    expect(result.x + item.width / 2).toBeLessThanOrEqual(6);
  });
  it('房屋的门口必须留在可行走的岛上范围内', () => {
    const result = clampPlacement({ ...state.placements[0]!, y: 8 }, definitions[0]!);
    expect(result.y + definitions[0]!.depth / 2 + 0.6).toBeLessThanOrEqual(7.5);
  });
  it('不能覆盖另一件物品和房门通道', () => {
    const tree = { id: 'tree-1', item_key: 'tree', x: -3, y: -2, rotation: 0 as const, zone: 'outdoor' as const };
    expect(canPlace(tree, state.placements, definitions)).toBe(false);
    expect(canPlace({ ...tree, x: 6, y: -4 }, state.placements, definitions)).toBe(true);
  });
  it('路径绕过房屋并到达目标，无法进入障碍物中心', () => {
    const path = findPath({ x: -7.5, y: -7 }, { x: 5.5, y: -2 }, state.placements, definitions);
    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toEqual({ x: 5.5, y: -2 });
    expect(path.every((point) => isWalkable(point, state.placements, definitions))).toBe(true);
    expect(findPath({ x: 0, y: 3 }, { x: -3, y: -2 }, state.placements, definitions)).toEqual([]);
  });
});
