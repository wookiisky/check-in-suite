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
  facing: number; // 屏幕朝向，正值向右。
}

// 角色初始位于小屋前方，不从房屋或器材内部开始。
export function createActor(placements: IslandPlacement[] = [], catalog: IslandDefinition[] = []): IslandActor {
  const candidates: IslandPoint[] = [{ x: 0, y: 4 }];
  for (let y = 6; y >= -7; y -= 1) for (let x = -7; x <= 7; x += 1) candidates.push({ x, y });
  const point = candidates.find((candidate) => isWalkable(candidate, placements, catalog)) ?? { x: -7.5, y: 7.5 };
  return { ...point, zone: 'outdoor', phase: 'idle', action: 'idle', targetID: null, destination: 'idle', route: [], elapsed: 0, facing: 1 };
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
  if (actor.targetID && !placements.some((item) => item.id === actor.targetID)) return { ...actor, phase: 'idle', action: 'idle', route: [], targetID: null, elapsed: 0 };
  if (actor.phase === 'walking') {
    const next = actor.route[0];
    if (!next) return { ...actor, phase: actor.destination === 'idle' ? 'idle' : 'acting', action: actor.destination, elapsed: 0 };
    if (next.zone !== actor.zone) return { ...actor, ...next, route: actor.route.slice(1), elapsed: 0 };
    const dx = next.x - actor.x;
    const dy = next.y - actor.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.min(distance, seconds * 2.2);
    return { ...actor, x: distance ? actor.x + dx / distance * step : next.x, y: distance ? actor.y + dy / distance * step : next.y, route: distance <= step ? actor.route.slice(1) : actor.route, facing: dx - dy < 0 ? -1 : 1, elapsed };
  }
  if (actor.phase === 'acting') return elapsed >= 8 ? { ...actor, phase: 'idle', action: 'idle', targetID: null, elapsed: 0 } : { ...actor, elapsed };
  if (elapsed < 4) return { ...actor, elapsed };
  const targets = placements.filter((placement) => catalog.find((item) => item.key === placement.item_key)?.activity);
  if (targets.length && random() < 0.65) {
    const target = targets[Math.min(targets.length - 1, Math.floor(random() * targets.length))]!;
    const activity = startActivity(actor, target.id, placements, catalog);
    if (activity) return activity;
  }
  const point: ActivityStep = { x: Math.round((random() * 2 - 1) * 6), y: Math.round((random() * 2 - 1) * 6), zone: 'outdoor' };
  const route = routeTo(actor, point, placements, catalog);
  return route?.length ? { ...actor, phase: 'walking', action: 'walk', destination: 'idle', targetID: null, route, elapsed: 0 } : { ...actor, phase: 'acting', action: 'rest', targetID: null, elapsed: 0 };
}
