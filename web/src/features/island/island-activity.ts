import { findPath, interactionPoint, isWalkable } from './island-geometry';
import type { IslandActivity, IslandDefinition, IslandPlacement, IslandPoint, IslandZone } from './island-types';

// 路径上的区域切换只发生在房门处，房屋剖面由角色区域决定。
interface ActivityStep extends IslandPoint {
  zone: IslandZone; // 当前路径点所属空间。
}

// 活动状态与SVG动画分开，使自主活动和点击互动共用执行逻辑。
export interface IslandActor extends ActivityStep {
  phase: 'idle' | 'walking' | 'acting'; // 活动执行阶段。
  action: IslandActivity | 'idle' | 'walk' | 'rest'; // 当前视觉动作。
  targetID: string | null; // 活动物品实例，移除后取消。
  destination: IslandActivity | 'idle'; // 到达目的地之后执行的动作。
  route: ActivityStep[]; // 可达的地面路径。
  elapsed: number; // 当前阶段已运行秒数。
  motionElapsed: number; // 角色累计动画秒数，换活动或过房门时不重置姿势。
  facing: number; // 屏幕朝向，正值向右。
}

// 角色初始位于小屋前方，不从房屋或器材内部开始。
export function createActor(placements: IslandPlacement[] = [], catalog: IslandDefinition[] = []): IslandActor {
  const candidates: IslandPoint[] = [{ x: 0, y: 4 }];
  for (let y = 6; y >= -7; y -= 1) for (let x = -7; x <= 7; x += 1) candidates.push({ x, y });
  const point = candidates.find((candidate) => isWalkable(candidate, placements, catalog)) ?? { x: -7.5, y: 7.5 };
  return { ...point, zone: 'outdoor', phase: 'idle', action: 'idle', targetID: null, destination: 'idle', route: [], elapsed: 0, motionElapsed: 0, facing: 1 };
}

// 跨房门的路径由室内、室外两段组成，区域切换不跨越墙壁。
function routeTo(actor: IslandActor, end: ActivityStep, placements: IslandPlacement[], catalog: IslandDefinition[]): ActivityStep[] | null {
  const routeWithin = (from: IslandPoint, to: IslandPoint, zone: IslandZone) => {
    if (Math.hypot(from.x - to.x, from.y - to.y) < 0.3) return [];
    const route = findPath(from, to, placements, catalog, zone);
    return route.length ? route.map((point) => ({ ...point, zone })) : null;
  };
  if (actor.zone === end.zone) return routeWithin(actor, end, end.zone);
  const house = placements.find((item) => catalog.find((entry) => entry.key === item.item_key)?.category === 'house');
  const houseDefinition = catalog.find((entry) => entry.key === house?.item_key);
  if (!house || !houseDefinition) return null;
  const outdoorDoor = { ...interactionPoint(house, houseDefinition), zone: 'outdoor' as const };
  const indoorDoor = { x: 0, y: 1.5, zone: 'indoor' as const };
  const exit = actor.zone === 'outdoor' ? outdoorDoor : indoorDoor;
  const entrance = actor.zone === 'outdoor' ? indoorDoor : outdoorDoor;
  const first = routeWithin(actor, exit, actor.zone);
  const second = routeWithin(entrance, end, end.zone);
  if (!first || !second) return null;
  return [...first, entrance, ...second];
}

// 物品的活动能力由目录声明，静态物品不产生空互动。
export function startActivity(actor: IslandActor, id: string, placements: IslandPlacement[], catalog: IslandDefinition[]): IslandActor | null {
  const target = placements.find((item) => item.id === id);
  const definition = catalog.find((item) => item.key === target?.item_key);
  if (!target || !definition?.activity) return null;
  const point = interactionPoint(target, definition);
  const route = routeTo(actor, { ...point, zone: target.zone }, placements, catalog);
  if (!route) return null;
  return { ...actor, phase: route.length ? 'walking' : 'acting', action: route.length ? 'walk' : definition.activity, destination: definition.activity, targetID: id, route, elapsed: 0 };
}

// 时间和随机源可注入，页面在隐藏或暂停时不调用此函数。
export function advanceActor(actor: IslandActor, seconds: number, placements: IslandPlacement[], catalog: IslandDefinition[], random: () => number = Math.random): IslandActor {
  const elapsed = actor.elapsed + seconds;
  const motionElapsed = actor.motionElapsed + seconds;
  if (actor.targetID && !placements.some((item) => item.id === actor.targetID)) return { ...actor, motionElapsed, phase: 'idle', action: 'idle', route: [], targetID: null, elapsed: 0 };
  if (actor.phase === 'walking') {
    let { x, y, facing } = actor;
    let remaining = seconds * 2.2;
    let cursor = 0;
    // 同一帧可以沿原路径经过多个点，避免每到半格就丢失剩余位移。
    while (cursor < actor.route.length && remaining > 0) {
      const next = actor.route[cursor]!;
      // 房门两侧采用不同坐标，切换后停止本帧，不将剩余距离带入室内外。
      if (next.zone !== actor.zone) return { ...actor, ...next, facing, motionElapsed, route: actor.route.slice(cursor + 1), elapsed: 0 };
      const dx = next.x - x, dy = next.y - y;
      const distance = Math.hypot(dx, dy);
      // 投影后的水平分量是 dx - dy；竖直移动和浮点残差保持原朝向。
      if (Math.abs(dx - dy) > 1e-6) facing = dx - dy < 0 ? -1 : 1;
      if (distance > remaining) {
        x += dx / distance * remaining;
        y += dy / distance * remaining;
        break;
      }
      x = next.x; y = next.y;
      remaining -= distance;
      cursor += 1;
    }
    const route = cursor ? actor.route.slice(cursor) : actor.route;
    if (!route.length) return { ...actor, x, y, facing, route, motionElapsed, phase: actor.destination === 'idle' ? 'idle' : 'acting', action: actor.destination, elapsed: 0 };
    return { ...actor, x, y, facing, route, elapsed, motionElapsed };
  }
  if (actor.phase === 'acting') return elapsed >= 8 ? { ...actor, motionElapsed, phase: 'idle', action: 'idle', targetID: null, elapsed: 0 } : { ...actor, elapsed, motionElapsed };
  if (elapsed < 4) return { ...actor, elapsed, motionElapsed };
  const targets = placements.filter((placement) => catalog.find((item) => item.key === placement.item_key)?.activity);
  if (targets.length && random() < 0.65) {
    const target = targets[Math.min(targets.length - 1, Math.floor(random() * targets.length))]!;
    const activity = startActivity(actor, target.id, placements, catalog);
    if (activity) return { ...activity, motionElapsed };
  }
  const point: ActivityStep = { x: Math.round((random() * 2 - 1) * 6), y: Math.round((random() * 2 - 1) * 6), zone: 'outdoor' };
  const route = routeTo(actor, point, placements, catalog);
  return route?.length ? { ...actor, motionElapsed, phase: 'walking', action: 'walk', destination: 'idle', targetID: null, route, elapsed: 0 } : { ...actor, motionElapsed, phase: 'acting', action: 'rest', targetID: null, elapsed: 0 };
}
