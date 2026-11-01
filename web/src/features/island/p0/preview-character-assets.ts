import type { CharacterSampleDefinition } from '../../character/p0/sample-appearance';

export const previewCharacterDefinitionURL = '/models/p0/character/character.json';
export const previewAnimationURL = '/models/p0/animations/exercise.glb';

// 同源读取与 GLB 一起产出的描述，不重复维护部件清单。
export async function readPreviewCharacterDefinition(signal: AbortSignal): Promise<CharacterSampleDefinition> {
  const response = await fetch(previewCharacterDefinitionURL, { signal });
  if (!response.ok) throw new Error(`P0_CHARACTER_DEFINITION_HTTP_${response.status}`);
  return response.json();
}
