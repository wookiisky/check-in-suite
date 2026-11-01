import type { components } from '../../api/schema';

type AppearanceState = components['schemas']['AppearanceState'];

// 原始动作选择包含人物身份，换人物后不会误用另一套目录的同一序号。
export function previewActionKey(characterKey: string, index: number): string {
  return `preview:${characterKey}:${index}`;
}

// 新响应共用一份目录，旧响应仍使用所选人物原有的预览动作。
export function characterPreviewAnimations(snapshot: AppearanceState): NonNullable<AppearanceState['preview_animations']> {
  return snapshot.preview_animations ?? snapshot.characters.find((item) => item.character_key === snapshot.character_key)?.preview_animations ?? [];
}

// 仅预览快照映射当前原始动作，正式快照和营地语义动作不受影响。
export function resolveCharacterPreviewAction(snapshot: AppearanceState, selection: string): { snapshot: AppearanceState; action: string } {
  const definition = snapshot.characters.find((item) => item.character_key === snapshot.character_key);
  const animation = characterPreviewAnimations(snapshot).find((_, index) => previewActionKey(snapshot.character_key, index) === selection);
  if (!definition || !animation) return { snapshot, action: definition && Object.hasOwn(definition.animations, selection) ? selection : 'idle' };
  return {
    snapshot: { ...snapshot, characters: snapshot.characters.map((item) => item.character_key === definition.character_key ? { ...item, animations: { ...item.animations, _preview: animation } } : item) },
    action: '_preview',
  };
}
