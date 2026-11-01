import type { components } from '../../api/schema';

export type AppearanceState = components['schemas']['AppearanceState'];
export type AppearanceDraft = Pick<AppearanceState, 'character_key' | 'hair_purchase_id' | 'upper_purchase_id' | 'lower_purchase_id' | 'shoes_purchase_id'>;
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
export function draftFromAppearance(snapshot: AppearanceState): AppearanceDraft {
  return { character_key: snapshot.character_key, hair_purchase_id: snapshot.hair_purchase_id, upper_purchase_id: snapshot.upper_purchase_id, lower_purchase_id: snapshot.lower_purchase_id, shoes_purchase_id: snapshot.shoes_purchase_id };
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
  const wearables = characterSlots.map((slot) => {
    const purchaseID = draft[`${slot}_purchase_id`];
    const owned = purchaseID === null ? null : snapshot.inventory.find((item) => item.purchase_id === purchaseID);
    if (purchaseID !== null && !owned) throw new Error('CHARACTER_PURCHASE_MISSING');
    const key = owned ? owned.wearable_key : definition.defaults[slot];
    const wearable = snapshot.wearables.find((item) => item.wearable_key === key);
    if (!wearable || wearable.slot !== slot || wearable.character_key !== definition.character_key || wearable.rig_key !== definition.rig_key) throw new Error('CHARACTER_WEARABLE_INCOMPATIBLE');
    return wearable;
  });
  const preparedAttachments = attachments.map((item) => ({ model_url: item.model_url, bone: item.bone, matrix: [...item.matrix] }));
  return { key: JSON.stringify([definition.character_key, ...wearables.map((item) => item.wearable_key), preparedAttachments]), definition, wearables, attachments: preparedAttachments };
}
