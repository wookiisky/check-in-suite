import { describe, expect, it } from 'vitest';
import { appearanceFixture } from './character3d-test-fixtures';
import { draftFromAppearance, resolveAppearance } from './character3d-appearance';

describe('正式人物外观解析', () => {
  it('空槽解析免费默认，购买实例按目录身份选择', () => {
    const snapshot = appearanceFixture();
    const resolved = resolveAppearance(snapshot);
    expect(resolved.wearables.map((item) => item.wearable_key)).toEqual(['hair-a', 'upper-a', 'lower-a', 'shoes-a']);
    const draft = { ...draftFromAppearance(snapshot), upper_purchase_id: 'purchase-upper' };
    expect(resolveAppearance(snapshot, draft).wearables[1]?.wearable_key).toBe('upper-b');
    expect(snapshot.upper_purchase_id).toBeNull();
    expect(resolveAppearance({ ...snapshot, version: 2 })).toEqual(resolved);
  });

  it('拒绝不属于库存、错误部位和不兼容身体骨架', () => {
    const snapshot = appearanceFixture(); const draft = draftFromAppearance(snapshot);
    expect(() => resolveAppearance(snapshot, { ...draft, upper_purchase_id: 'absent' })).toThrow();
    expect(() => resolveAppearance(snapshot, { ...draft, upper_purchase_id: 'purchase-hair' })).toThrow();
    expect(() => resolveAppearance(snapshot, { ...draft, character_key: 'unknown' })).toThrow();
    snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!.rig_key = 'other';
    expect(() => resolveAppearance(snapshot, { ...draft, upper_purchase_id: 'purchase-upper' })).toThrow();
    snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!.rig_key = 'rig';
    snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!.character_key = 'other-body';
    expect(() => resolveAppearance(snapshot, { ...draft, upper_purchase_id: 'purchase-upper' })).toThrow();
  });

  it('活动道具及其精确变换属于一次异步准备的身份', () => {
    const snapshot = appearanceFixture();
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 1];
    const attachment = { model_url: '/book.glb', bone: 'handslotl', matrix };
    const resolved = resolveAppearance(snapshot, undefined, [attachment]);
    expect(resolved.key).not.toBe(resolveAppearance(snapshot).key);
    matrix[12] = 0.8;
    expect(resolved.attachments[0]!.matrix[12]).toBe(0.1);
    expect(resolveAppearance(snapshot, undefined, [attachment]).key).not.toBe(resolved.key);
  });
});
