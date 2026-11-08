import type { components } from '../../api/schema';

export type AppearanceState = components['schemas']['AppearanceState'];
export type WearableColorField = `${Exclude<CharacterSlot, 'face'>}_color_key`;
export const wearableColorFields: Partial<Record<CharacterSlot, WearableColorField>> = {
  head: 'head_color_key',
  upper: 'upper_color_key',
  lower: 'lower_color_key',
  shoes: 'shoes_color_key',
  back: 'back_color_key',
};
export type AppearanceDraft = Pick<AppearanceState, 'character_key' | `${CharacterSlot}_wearable_key` | WearableColorField>;
export type CharacterDefinition = components['schemas']['CharacterDefinition'];
export type CharacterWearable = components['schemas']['CharacterWearable'];
export type CharacterLoadStatus = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; error: unknown };
export const characterSlots = ['face', 'head', 'upper', 'lower', 'shoes', 'back'] as const;
export type CharacterSlot = typeof characterSlots[number];

// 活动道具由受控场景提供，不属于购买或穿戴槽位。
export interface CharacterAttachment {
  readonly model_url: string; // 静态道具的同源模型地址。
  readonly bone: string; // GLTFLoader 实际使用的骨骼名。
  readonly matrix: readonly number[]; // 相对该骨骼的列主序四乘四矩阵。
}

// 外观编辑只持有选择，库存和目录继续来自确认后的服务器快照。
export function draftFromAppearance(snapshot: AppearanceDraft): AppearanceDraft {
  const draft: AppearanceDraft = { character_key: snapshot.character_key, face_wearable_key: snapshot.face_wearable_key, back_wearable_key: snapshot.back_wearable_key, head_wearable_key: snapshot.head_wearable_key, upper_wearable_key: snapshot.upper_wearable_key, lower_wearable_key: snapshot.lower_wearable_key, shoes_wearable_key: snapshot.shoes_wearable_key };
  for (const slot of characterSlots) {
    const colorField = wearableColorFields[slot];
    if (colorField && snapshot[colorField] != null) draft[colorField] = snapshot[colorField];
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


// 已取得身体的基础部件无需订单，未购买身体的默认项不能借免费来源使用。
export function freeCharacterDefinitions(snapshot: AppearanceState): CharacterDefinition[] {
  const owned = new Set(snapshot.character_inventory?.map((item) => item.character_key));
  const initial = snapshot.default_character_key || snapshot.characters[0]?.character_key;
  return snapshot.characters.filter((item) => item.character_key === initial || owned.has(item.character_key));
}

// 目录颜色在解析时转换为渲染使用的材质名与 sRGB 色值。
export interface ResolvedWearableDye {
  wearable: CharacterWearable; // 颜色只作用于该部件的节点。
  material: string; // GLB 中可染色的材质名。
  hex: string; // 色板中的 sRGB 色值。
}

// 解析结果由资源身份决定，与购买分页、名称和图片前缀无关。
export interface ResolvedAppearance {
  key: string; // 人物定义、所选部件、配色和活动道具组成的准备身份。
  definition: CharacterDefinition; // 同一个实例使用的规范身体。
  wearables: CharacterWearable[]; // 按六个固定部位排序。
  dyes: ResolvedWearableDye[]; // 需要覆盖模型底色的部件。
  attachments: readonly CharacterAttachment[]; // 与人物一起准备和切换的活动道具。
}

// null 只能回到已声明的默认项，错误所有权或兼容性不静默换成别的衣服。
export function resolveAppearance(snapshot: AppearanceState, draft = draftFromAppearance(snapshot), attachments: readonly CharacterAttachment[] = []): ResolvedAppearance {
  const definition = snapshot.characters.find((item) => item.character_key === draft.character_key);
  if (!definition) throw new Error('CHARACTER_DEFINITION_MISSING');
  const definitions = new Map(snapshot.wearables.map((item) => [item.wearable_key, item]));
  const entitled = new Set(snapshot.inventory.map((item) => item.wearable_key));
  for (const body of freeCharacterDefinitions(snapshot)) {
    for (const slot of characterSlots) entitled.add(body.defaults[slot]);
  }
  const wearables = characterSlots.map((slot) => {
    const chosen = draft[`${slot}_wearable_key`];
    if (chosen !== null && !entitled.has(chosen)) throw new Error('CHARACTER_WEARABLE_UNOWNED');
    const key = chosen ?? definition.defaults[slot];
    const wearable = definitions.get(key);
    if (!wearable || wearable.slot !== slot || !wearableFitsCharacter(wearable, definition, snapshot.characters)) throw new Error('CHARACTER_WEARABLE_INCOMPATIBLE');
    return wearable;
  });
  const preparedAttachments = attachments.map((item) => ({ model_url: item.model_url, bone: item.bone, matrix: [...item.matrix] }));
  const dyes = wearables.flatMap((wearable) => {
    const field = wearableColorFields[wearable.slot];
    const colorKey = field && draft[field];
    if (colorKey == null || colorKey === wearable.default_color_key) return [];
    const color = snapshot.wearable_colors?.find((item) => item.key === colorKey);
    if (!wearable.dye_material || !color) throw new Error('CHARACTER_WEARABLE_COLOR_INVALID');
    return [{ wearable, material: wearable.dye_material, hex: color.hex }];
  });
  const body = [definition.character_key, definition.model_asset_key, definition.model_url, definition.scale, definition.fixed_nodes, definition.body_regions];
  const animations = Object.entries(definition.animations).sort(([first], [second]) => first.localeCompare(second));
  const parts = wearables.map((item) => [item.wearable_key, item.model_asset_key, item.model_url, item.nodes, item.covers, item.regions]);
  const dyeIdentity = dyes.map(({ wearable, material, hex }) => [wearable.wearable_key, material, hex]);
  return { key: JSON.stringify([body, animations, parts, dyeIdentity, preparedAttachments]), definition, wearables, dyes, attachments: preparedAttachments };
}
