import { describe, expect, it } from 'vitest';
import { advanceActor, createActor, startActivity } from './island-activity';
import { canPlace, isWalkable } from './island-geometry';
import { state } from './island-test-fixtures';

describe('角色活动', () => {
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
