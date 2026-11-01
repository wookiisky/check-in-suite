import type { components } from '../../api/schema';
import content from './character-verification-content.json';
import { previewActionKey } from './character-preview-actions';

type Animation = components['schemas']['CharacterDefinition']['animations'][string];

// 检查入口展示目录中的全部动作，原始动作沿用素材提供的名称。
export function CharacterActionPicker({ characterKey, animations, previewAnimations = [], value, onChange }: { characterKey: string; animations: Record<string, Animation>; previewAnimations?: Animation[]; value: string; onChange: (value: string) => void }) {
  return <label>{content.action}<select aria-label={content.action} value={value} onChange={(event) => onChange(event.target.value)}>
    {Object.entries(animations).map(([name, animation]) => <option key={name} value={name}>{content.actions[name as keyof typeof content.actions] ?? animation.clip}</option>)}
    {previewAnimations.map((animation, index) => <option key={previewActionKey(characterKey, index)} value={previewActionKey(characterKey, index)}>{content.sourceAction.replace('{clip}', animation.clip)}</option>)}
  </select></label>;
}
