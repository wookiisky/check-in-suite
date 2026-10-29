import { HumanCharacterArtwork } from '../character/HumanCharacterArtwork';
import artwork from '../character/character-artwork.json';
import type { Equipment } from './types';
import content from './content.json';

// 免费基础形象与购买装备分开选择，切换时保留发型和衣服。
export function BaseAvatarPicker({ equipment, busy, onSelect }: {
  equipment: Equipment;
  busy: boolean;
  onSelect: (key: string) => void;
}) {
  return <section className="shop-base-avatars" aria-label={content.baseAvatars}>
    <h3>{content.baseAvatars}</h3>
    <div className="shop-base-avatar-options">
      {artwork.baseAvatars.map((item) => <button type="button" key={item.key} className="secondary shop-base-avatar" disabled={busy}
        aria-pressed={!equipment.avatar && equipment.base_avatar_key === item.key}
        onClick={() => onSelect(item.key)}>
        <HumanCharacterArtwork baseAvatarKey={item.key} className="shop-base-avatar-art" />
        <span>{content.baseAvatarNames[item.key as keyof typeof content.baseAvatarNames]}</span>
      </button>)}
    </div>
    <p className="shop-hint">{content.freeBaseAvatar}</p>
    {equipment.avatar && <p className="shop-hint">{content.animalWearableHint}</p>}
  </section>;
}
