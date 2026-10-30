import { houseLayout, houseWalls, housePassages, overlapsHouseRectangle } from './house-layout';
import type { IslandDefinition, IslandPlacement, IslandPoint, IslandView, IslandZone } from './island-types';

// 窄屏允许把整个营地缩入浮层之间，手势和默认取景共用下限。
export const minimumIslandZoom = 0.45;

// 固定斜俯视投影只存在于绘图层，业务状态始终使用地面坐标。
export function project(point: IslandPoint): IslandPoint {
  return { x: 500 + (point.x - point.y) * 24, y: 350 + (point.x + point.y) * 12 };
}

// 投影逆变换用于任何缩放倍率下的物品拖放。
export function unproject(point: IslandPoint): IslandPoint {
  return { x: (point.x - 500) / 48 + (point.y - 350) / 24, y: (point.y - 350) / 24 - (point.x - 500) / 48 };
}

// 室内以房屋中心为原点，采用与室外一致的固定斜俯视投影。
export function projectInterior(point: IslandPoint, house: IslandPlacement, _definition: IslandDefinition): IslandPoint {
  const origin = project(house);
  return { x: origin.x + (point.x - point.y) * 24, y: origin.y + (point.x + point.y) * 12 };
}

// 拖放逆投影独立于相机缩放，避免室内物品跟随指针时发生漂移。
export function unprojectInterior(point: IslandPoint, house: IslandPlacement, _definition: IslandDefinition): IslandPoint {
  const origin = project(house);
  return { x: (point.x - origin.x) / 48 + (point.y - origin.y) / 24, y: (point.y - origin.y) / 24 - (point.x - origin.x) / 48 };
}

// 以指针所在场景点缩放，避免画布在手势期间跳动。
export function zoomAt(view: IslandView, pointer: IslandPoint, factor: number): IslandView {
  const zoom = Math.min(2.5, Math.max(Math.min(minimumIslandZoom, view.zoom), view.zoom * factor));
  return { zoom, x: pointer.x - (pointer.x - view.x) * zoom / view.zoom, y: pointer.y - (pointer.y - view.y) * zoom / view.zoom };
}

// 四分之一圈朝向只交换矩形占地，不改变相机视角。
export function footprint(placement: IslandPlacement, definition: IslandDefinition): IslandPoint {
  return placement.rotation % 180 === 0 ? { x: definition.width, y: definition.depth } : { x: definition.depth, y: definition.width };
}

// 连同物品边缘约束到室内或岛屿区域。
export function clampPlacement(placement: IslandPlacement, definition: IslandDefinition): IslandPlacement {
  const limitX = placement.zone === 'indoor' ? houseLayout.width / 2 : 8;
  const limitY = placement.zone === 'indoor' ? houseLayout.depth / 2 : 8;
  const size = footprint(placement, definition);
  const needsEntrance = definition.category === 'house' || Boolean(definition.activity);
  const maxY = needsEntrance ? Math.min(limitY - size.y / 2, limitY - 0.5 - size.y / 2 - 0.6) : limitY - size.y / 2;
  const snap = (value: number, min: number, max: number) => Math.max(Math.ceil(min * 4) / 4, Math.min(Math.floor(max * 4) / 4, Math.round(value * 4) / 4));
  return { ...placement, x: snap(placement.x, -limitX + size.x / 2, limitX - size.x / 2), y: snap(placement.y, -limitY + size.y / 2, maxY) };
}

// 活动物件入口位于近侧，人物无需穿进物件中心。
export function interactionPoint(placement: IslandPlacement, definition: IslandDefinition): IslandPoint {
  return { x: placement.x, y: placement.y + footprint(placement, definition).y / 2 + 0.6 };
}

// 布置时保留房门通道，生物和环境不占据步行空间。
export function canPlace(next: IslandPlacement, placements: IslandPlacement[], catalog: IslandDefinition[]): boolean {
  const definition = catalog.find((item) => item.key === next.item_key);
  if (!definition) return false;
  if (definition.indoor_only && next.zone !== 'indoor') return false;
  if ((definition.category === 'house' || definition.category === 'environment' || definition.category === 'creature' || definition.model === 'run') && next.zone !== 'outdoor') return false;
  const size = footprint(next, definition);
  const limitX = next.zone === 'indoor' ? houseLayout.width / 2 : 8;
  const limitY = next.zone === 'indoor' ? houseLayout.depth / 2 : 8;
  if (Math.abs(next.x) + size.x / 2 > limitX || Math.abs(next.y) + size.y / 2 > limitY) return false;
  if (next.zone === 'indoor' && [...houseWalls, ...housePassages].some((rectangle) => overlapsHouseRectangle(next, size, rectangle))) return false;
  if (definition.category === 'environment' || definition.category === 'creature') return true;
  if (definition.category === 'house' || definition.activity) {
    const entrance = interactionPoint(next, definition);
    if (Math.abs(entrance.x) > limitX - 0.5 || Math.abs(entrance.y) > limitY - 0.5) return false;
  }
  return placements.every((other) => {
    if (other.id === next.id || other.zone !== next.zone) return true;
    const item = catalog.find((entry) => entry.key === other.item_key);
    if (!item || item.category === 'environment' || item.category === 'creature') return true;
    const extent = footprint(other, item);
    if (Math.abs(next.x - other.x) < (size.x + extent.x) / 2 + 0.15 && Math.abs(next.y - other.y) < (size.y + extent.y) / 2 + 0.15) return false;
    const house = definition.category === 'house' ? next : item.category === 'house' ? other : null;
    const houseDefinition = definition.category === 'house' ? definition : item;
    if (house) {
      const point = interactionPoint(house, houseDefinition);
      const target = house === next ? other : next;
      const targetSize = house === next ? extent : size;
      if (Math.abs(target.x - point.x) < targetSize.x / 2 + 0.55 && Math.abs(target.y - point.y) < targetSize.y / 2 + 0.55) return false;
    }
    return true;
  });
}

// 出生点与行走共享空间判定，生物不会成为不可通过的障碍。
export function isWalkable(point: IslandPoint, placements: IslandPlacement[], catalog: IslandDefinition[], zone: IslandZone = 'outdoor'): boolean {
  const limitX = zone === 'outdoor' ? 7.5 : houseLayout.width / 2 - houseLayout.passageClearance;
  const limitY = zone === 'outdoor' ? 7.5 : houseLayout.depth / 2 - houseLayout.passageClearance;
  if (Math.abs(point.x) > limitX || Math.abs(point.y) > limitY) return false;
  const actorSize = { x: houseLayout.passageClearance * 2, y: houseLayout.passageClearance * 2 };
  if (zone === 'indoor' && houseWalls.some((rectangle) => overlapsHouseRectangle(point, actorSize, rectangle))) return false;
  return !placements.some((placement) => {
    if (placement.zone !== zone) return false;
    const item = catalog.find((entry) => entry.key === placement.item_key);
    if (!item || item.category === 'environment' || item.category === 'creature') return false;
    const size = footprint(placement, item);
    return Math.abs(point.x - placement.x) < size.x / 2 + 0.15 && Math.abs(point.y - placement.y) < size.y / 2 + 0.15;
  });
}

// 小岛规模固定，用半格宽的广度搜索保留简单可验证的避障行为。
export function findPath(start: IslandPoint, end: IslandPoint, placements: IslandPlacement[], catalog: IslandDefinition[], zone: IslandZone = 'outdoor'): IslandPoint[] {
  const startCell = { x: Math.round(start.x * 2), y: Math.round(start.y * 2) };
  const endCell = { x: Math.round(end.x * 2), y: Math.round(end.y * 2) };
  const key = (point: IslandPoint) => `${point.x},${point.y}`;
  const blocked = (point: IslandPoint) => !isWalkable({ x: point.x / 2, y: point.y / 2 }, placements, catalog, zone);
  if (!isWalkable(end, placements, catalog, zone) || blocked(endCell)) return [];
  const queue = [startCell];
  const parents = new Map<string, IslandPoint | null>([[key(startCell), null]]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (key(current) === key(endCell)) {
      const path: IslandPoint[] = [];
      let step: IslandPoint | null = current;
      while (step && key(step) !== key(startCell)) {
        path.unshift({ x: step.x / 2, y: step.y / 2 });
        step = parents.get(key(step)) ?? null;
      }
      if (path.length) path[path.length - 1] = end;
      return path;
    }
    for (const direction of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      if (!parents.has(key(next)) && !blocked(next)) { parents.set(key(next), current); queue.push(next); }
    }
  }
  return [];
}
