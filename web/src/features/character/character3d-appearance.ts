import type { components } from '../../api/schema';

export type AppearanceState = components['schemas']['AppearanceState'];
export type FreeWearableSelection = Partial<Record<`${CharacterSlot}_free_wearable_key`, string | null>>;
export type AppearanceDraft = Pick<AppearanceState, 'character_key' | 'hair_purchase_id' | 'upper_purchase_id' | 'lower_purchase_id' | 'shoes_purchase_id'> & FreeWearableSelection;
export type CharacterDefinition = components['schemas']['CharacterDefinition'];
export type CharacterWearable = components['schemas']['CharacterWearable'];
export type CharacterLoadStatus = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; error: unknown };
export const characterSlots = ['hair', 'upper', 'lower', 'shoes'] as const;
export type CharacterSlot = typeof characterSlots[number];

// 活动道具由受控场景提供，不属于购买或穿戴槽位。
export interface CharacterAttachment {
  readonly model_url: string; // 静态道具的同源模型地址。
  readonly bone: string; // GLTFLoader 实际使用的骨骼名。
  readonly matrix: readonly number[]; // 相对该骨骼的列主序四乘四矩阵。
}

// 外观编辑只持有选择，库存和目录继续来自确认后的服务器快照。
export function draftFromAppearance(snapshot: AppearanceState & FreeWearableSelection): AppearanceDraft {
  const draft: AppearanceDraft = { character_key: snapshot.character_key, hair_purchase_id: snapshot.hair_purchase_id, upper_purchase_id: snapshot.upper_purchase_id, lower_purchase_id: snapshot.lower_purchase_id, shoes_purchase_id: snapshot.shoes_purchase_id };
  for (const slot of characterSlots) {
    const field = `${slot}_free_wearable_key` as const;
    if (snapshot[field] != null) draft[field] = snapshot[field];
  }
  return draft;
}

// 身体标准与绑定骨架共同决定服装兼容性，原人物身份只用于兼容旧目录。
export function wearableFitsCharacter(wearable: CharacterWearable, definition: CharacterDefinition, characters: readonly CharacterDefinition[]): boolean {
  const source = characters.find((item) => item.character_key === wearable.character_key);
  const bodyKey = definition.body_key || definition.character_key;
  const wearableBodyKey = wearable.body_key || source?.body_key || wearable.character_key;
  return wearableBodyKey === bodyKey && wearable.rig_key === definition.rig_key;
}

// 解析结果由资源身份决定，与购买分页、名称和图片前缀无关。
export interface ResolvedAppearance {
  key: string; // 人物定义、所选部件和活动道具组成的准备身份。
  definition: CharacterDefinition; // 同一个实例使用的规范身体。
  wearables: CharacterWearable[]; // 按四个固定部位排序。
  attachments: readonly CharacterAttachment[]; // 与人物一起准备和切换的活动道具。
}

// null 只能回到已声明的默认项，错误所有权或兼容性不静默换成别的衣服。
export function resolveAppearance(snapshot: AppearanceState, draft = draftFromAppearance(snapshot), attachments: readonly CharacterAttachment[] = []): ResolvedAppearance {
  const definition = snapshot.characters.find((item) => item.character_key === draft.character_key);
  if (!definition) throw new Error('CHARACTER_DEFINITION_MISSING');
  const definitions = new Map(snapshot.wearables.map((item) => [item.wearable_key, item]));
  const wearables = characterSlots.map((slot) => {
    const purchaseID = draft[`${slot}_purchase_id`];
    const freeKey = draft[`${slot}_free_wearable_key`];
    if (freeKey != null) {
      const freeCharacter = snapshot.characters.find((item) => item.character_key === (snapshot.default_character_key || snapshot.characters[0]?.character_key));
      if (purchaseID !== null || freeKey !== freeCharacter?.defaults[slot]) throw new Error('CHARACTER_FREE_WEARABLE_INVALID');
    }
    const owned = purchaseID === null ? null : snapshot.inventory.find((item) => item.purchase_id === purchaseID && definitions.get(item.wearable_key)?.slot === slot);
    if (purchaseID !== null && !owned) throw new Error('CHARACTER_PURCHASE_MISSING');
    const key = owned ? owned.wearable_key : freeKey ?? definition.defaults[slot];
    const wearable = definitions.get(key);
    if (!wearable || wearable.slot !== slot || !wearableFitsCharacter(wearable, definition, snapshot.characters)) throw new Error('CHARACTER_WEARABLE_INCOMPATIBLE');
    return wearable;
  });
  const preparedAttachments = attachments.map((item) => ({ model_url: item.model_url, bone: item.bone, matrix: [...item.matrix] }));
  const body = [definition.character_key, definition.model_asset_key, definition.model_url, definition.scale, definition.fixed_nodes, definition.body_regions];
  const animations = Object.entries(definition.animations).sort(([first], [second]) => first.localeCompare(second));
  const parts = wearables.map((item) => [item.wearable_key, item.model_asset_key, item.model_url, item.nodes, item.covers]);
  return { key: JSON.stringify([body, animations, parts, preparedAttachments]), definition, wearables, attachments: preparedAttachments };
}
