import { describe, expect, it } from 'vitest';
import { advanceActor, createActor, startActivity } from './island-activity';
import type { IslandActor } from './island-activity';
import { canPlace, isWalkable } from './island-geometry';
import { state } from './island-test-fixtures';

describe('角色活动', () => {
  it.each([20, 60, 120])('每秒 %i 帧时沿多个路径点保持相同速度', (fps) => {
    let actor: IslandActor = { ...createActor(), x: 0, y: 0, phase: 'walking', action: 'walk',
      route: Array.from({ length: 10 }, (_, index) => ({ x: -(index + 1) / 2, y: 0, zone: 'outdoor' })) };
    for (let frame = 0; frame < fps; frame += 1) actor = advanceActor(actor, 1 / fps, [], []);
    expect(actor.x).toBeCloseTo(-2.2, 10);
    expect(actor.y).toBe(0);
    expect(actor.facing).toBe(-1);
  });
  it('单帧跨过拐点时沿既有路径消费距离，不抄近路', () => {
    const actor: IslandActor = { ...createActor(), x: 0, y: 0, phase: 'walking', action: 'walk',
      route: [{ x: 0.05, y: 0, zone: 'outdoor' }, { x: 0.05, y: 1, zone: 'outdoor' }] };
    const next = advanceActor(actor, 0.05, [], []);
    expect(next.x).toBe(0.05);
    expect(next.y).toBeCloseTo(0.06);
    expect(next.facing).toBe(-1);
    expect(actor.route).toHaveLength(2);
  });
  it.each([
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0.5 + Number.EPSILON, y: 0.5 },
  ])('零位移、竖直移动和浮点误差不会翻转朝向：%j', (point) => {
    const actor: IslandActor = { ...createActor(), x: 0, y: 0, facing: -1, phase: 'walking', action: 'walk',
      route: [{ ...point, zone: 'outdoor' }] };
    expect(advanceActor(actor, 0.05, [], []).facing).toBe(-1);
  });
  it('真实向右移动仍会转向，到点后精确停留且不将剩余时间用于新活动', () => {
    const actor: IslandActor = { ...createActor(), x: 0, y: 0, facing: -1, phase: 'walking', action: 'walk', destination: 'run',
      route: [{ x: 0.03, y: 0, zone: 'outdoor' }] };
    expect(advanceActor(actor, 1, [], [])).toMatchObject({ x: 0.03, y: 0, facing: 1, phase: 'acting', action: 'run', route: [], elapsed: 0 });
  });
  it('跨房门后结束当帧推进，不把室外剩余距离用于室内', () => {
    const actor: IslandActor = { ...createActor(), x: 0, y: 0, phase: 'walking', action: 'walk',
      route: [{ x: 0.03, y: 0, zone: 'outdoor' }, { x: 0, y: 1.5, zone: 'indoor' }, { x: 0, y: 0, zone: 'indoor' }] };
    const next = advanceActor(actor, 0.05, [], []);
    expect(next).toMatchObject({ x: 0, y: 1.5, zone: 'indoor', elapsed: 0 });
    expect(next.route).toEqual([{ x: 0, y: 0, zone: 'indoor' }]);
    expect(next.motionElapsed).toBeCloseTo(0.05);
  });
  it('视觉时间跨越活动结束和重新选择活动，业务计时仍单独归零', () => {
    const actor: IslandActor = { ...createActor(), phase: 'acting', action: 'rest', elapsed: 7.99, motionElapsed: 3 };
    const idle = advanceActor(actor, 0.02, state.placements, state.catalog);
    expect(idle).toMatchObject({ phase: 'idle', elapsed: 0, motionElapsed: 3.02 });
    const walking = startActivity(idle, 'base:run', state.placements, state.catalog)!;
    expect(walking.motionElapsed).toBeCloseTo(3.02);
    expect(advanceActor(walking, 0.02, state.placements, state.catalog).motionElapsed).toBeCloseTo(3.04);
  });
  it('房屋移到原出生点后，角色选择新的可行走位置', () => {
    const placements = state.placements.map((item) => item.item_key === 'house' ? { ...item, x: 0, y: 3.5 } : item.item_key === 'run' ? { ...item, x: 5.5, y: -2 } : item);
    expect(canPlace(placements[0]!, placements, state.catalog)).toBe(true);
    const actor = createActor(placements, state.catalog);
    expect(isWalkable(actor, placements, state.catalog)).toBe(true);
    expect(startActivity(actor, 'base:run', placements, state.catalog)).not.toBeNull();
  });
  it('较大房屋的默认布局仍可从室外进入阅读并返回运动区', () => {
    let actor = startActivity(createActor(), 'base:desk', state.placements, state.catalog)!;
    expect(actor.phase).toBe('walking');
    expect(actor.zone).toBe('outdoor');
    let visitedIndoors = false;
    for (let i = 0; i < 600 && actor.phase !== 'acting'; i += 1) {
      actor = advanceActor(actor, 0.1, state.placements, state.catalog, () => 0.9);
      visitedIndoors ||= actor.zone === 'indoor';
    }
    expect(visitedIndoors).toBe(true);
    expect(actor).toMatchObject({ zone: 'indoor', action: 'read', phase: 'acting', targetID: 'base:desk' });
    actor = startActivity(actor, 'base:run', state.placements, state.catalog)!;
    expect(actor).not.toBeNull();
    for (let i = 0; i < 600 && actor.phase !== 'acting'; i += 1) actor = advanceActor(actor, 0.1, state.placements, state.catalog, () => 0.9);
    expect(actor).toMatchObject({ zone: 'outdoor', action: 'run', phase: 'acting', targetID: 'base:run' });
  });
  it('互动对象被收起后取消活动，不能继续使用不存在的器材', () => {
    const actor = startActivity(createActor(), 'base:run', state.placements, state.catalog)!;
    const next = advanceActor(actor, 0.1, state.placements.filter((item) => item.id !== 'base:run'), state.catalog);
    expect(next).toMatchObject({ phase: 'idle', targetID: null });
  });
  it('静态物件不能触发不存在的活动', () => {
    expect(startActivity(createActor(), 'base:house', state.placements, state.catalog)).toBeNull();
  });
  it('目标完成后角色停留，后续调度可使用注入的随机数', () => {
    const actor = { ...createActor(), phase: 'acting' as const, action: 'rest' as const, elapsed: 9 };
    expect(advanceActor(actor, 0.1, state.placements, state.catalog)).toMatchObject({ phase: 'idle', action: 'idle' });
    const next = advanceActor({ ...createActor(), elapsed: 5 }, 0.1, state.placements, state.catalog, () => 0);
    expect(next.targetID).toBe('base:desk');
  });
});
