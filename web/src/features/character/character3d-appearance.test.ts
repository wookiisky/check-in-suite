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

  it('同一标准身体与骨架的不同人物共用已购四槽服装', () => {
    const snapshot = appearanceFixture();
    const first = snapshot.characters[0]!;
    Object.assign(first, { body_key: 'medium' });
    snapshot.characters.push({ ...first, character_key: 'second-character' });
    for (const item of snapshot.wearables) Object.assign(item, { body_key: 'medium' });
    const draft = { ...draftFromAppearance(snapshot), character_key: 'second-character', upper_purchase_id: 'purchase-upper' };
    const resolved = resolveAppearance(snapshot, draft);
    expect(resolved.definition.character_key).toBe('second-character');
    expect(resolved.wearables[1]?.wearable_key).toBe('upper-b');

    Object.assign(snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!, { body_key: 'large' });
    expect(() => resolveAppearance(snapshot, draft)).toThrow('CHARACTER_WEARABLE_INCOMPATIBLE');
  });

  it('旧服装通过原人物定义解析统一身体，仍拒绝未知身体与错误骨架', () => {
    const snapshot = appearanceFixture();
    const original = snapshot.characters[0]!;
    Object.assign(original, { body_key: 'medium' });
    snapshot.characters.push({ ...original, character_key: 'second-character' });
    const draft = { ...draftFromAppearance(snapshot), character_key: 'second-character', upper_purchase_id: 'purchase-upper' };
    expect(resolveAppearance(snapshot, draft).wearables[1]?.wearable_key).toBe('upper-b');
    const upper = snapshot.wearables.find((item) => item.wearable_key === 'upper-b')!;
    upper.character_key = 'unknown';
    expect(() => resolveAppearance(snapshot, draft)).toThrow('CHARACTER_WEARABLE_INCOMPATIBLE');
    Object.assign(upper, { body_key: 'medium' }); upper.rig_key = 'different-rig';
    expect(() => resolveAppearance(snapshot, draft)).toThrow('CHARACTER_WEARABLE_INCOMPATIBLE');
  });

  it('同一角色购买订单可分别作为四个槽的服装来源', () => {
    const snapshot = appearanceFixture();
    snapshot.inventory = snapshot.inventory.map((item) => ({ ...item, purchase_id: 'character-purchase' }));
    const draft = { ...draftFromAppearance(snapshot), hair_purchase_id: 'character-purchase', upper_purchase_id: 'character-purchase', lower_purchase_id: 'character-purchase', shoes_purchase_id: 'character-purchase' };
    expect(resolveAppearance(snapshot, draft).wearables.map((item) => item.wearable_key)).toEqual(['hair-b', 'upper-b', 'lower-b', 'shoes-b']);
    snapshot.inventory = snapshot.inventory.filter((item) => item.wearable_key !== 'lower-b');
    expect(() => resolveAppearance(snapshot, draft)).toThrow('CHARACTER_PURCHASE_MISSING');
  });

  it('稳定人物身份不掩盖模型版本或当前预览动作的变化', () => {
    const snapshot = appearanceFixture();
    const original = resolveAppearance(snapshot).key;
    const definition = snapshot.characters[0]!;
    definition.model_asset_key = 'updated-model'; definition.model_url = '/updated.glb';
    const updated = resolveAppearance(snapshot).key;
    expect(updated).not.toBe(original);
    definition.animations._preview = { clip: 'Wave', asset_key: 'gestures', url: '/gestures.glb' };
    const firstPreview = resolveAppearance(snapshot).key;
    expect(firstPreview).not.toBe(updated);
    definition.animations._preview = { clip: 'Dance', asset_key: 'gestures', url: '/gestures.glb' };
    expect(resolveAppearance(snapshot).key).not.toBe(firstPreview);
  });

  it('初始免费衣服也能穿给其他兼容人物，无需伪造购买订单', () => {
    const snapshot = appearanceFixture();
    Object.assign(snapshot, { default_character_key: 'body' });
    const first = snapshot.characters[0]!;
    Object.assign(first, { body_key: 'medium' });
    const second = { ...first, character_key: 'second', defaults: { ...first.defaults, upper: 'upper-b' } };
    snapshot.characters.push(second);
    const draft = { ...draftFromAppearance(snapshot), character_key: 'second', upper_free_wearable_key: 'upper-a' };
    expect(resolveAppearance(snapshot, draft).wearables[1]?.wearable_key).toBe('upper-a');
    Object.assign(snapshot, { character_key: 'second', upper_free_wearable_key: 'upper-a' });
    expect(draftFromAppearance(snapshot).upper_free_wearable_key).toBe('upper-a');
    expect(resolveAppearance(snapshot).wearables[1]?.wearable_key).toBe('upper-a');
  });

  it('免费来源不能指定付费人物衣服或和购买来源同时存在', () => {
    const snapshot = appearanceFixture();
    Object.assign(snapshot, { default_character_key: 'body' });
    const draft = draftFromAppearance(snapshot);
    expect(() => resolveAppearance(snapshot, { ...draft, upper_free_wearable_key: 'upper-b' })).toThrow('CHARACTER_FREE_WEARABLE_INVALID');
    expect(() => resolveAppearance(snapshot, { ...draft, upper_free_wearable_key: 'upper-a', upper_purchase_id: 'purchase-upper' })).toThrow('CHARACTER_FREE_WEARABLE_INVALID');
    expect(() => resolveAppearance(snapshot, { ...draft, upper_free_wearable_key: '' })).toThrow('CHARACTER_FREE_WEARABLE_INVALID');
  });
});
