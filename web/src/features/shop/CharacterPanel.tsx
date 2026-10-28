import type { Equipment } from './types';
import { assetURL } from './helpers';
import content from './content.json';
import './shop.css';

// 饰品围绕角色上下排布，十个素材全部可见，不遮挡任何操作入口。
export function CharacterPanel({
  equipment,
  displayName,
}: {
  equipment: Equipment;
  displayName: string;
}) {
  const avatar = equipment.avatar;
  return (
    <section className="shop-character" aria-label={content.character}>
      <h3>{displayName}</h3>
      {equipment.title ? (
        <p className="shop-character-title">
          <img src={assetURL(equipment.title.asset_key_snapshot)} alt="" />
          {equipment.title.name_snapshot}
        </p>
      ) : (
        <p className="shop-hint">{content.emptyTitle}</p>
      )}
      <div className="shop-character-stage">
        {equipment.accessories.map((item, index) => (
          <img
            className="shop-accessory-art"
            key={item.id}
            src={assetURL(item.asset_key_snapshot)}
            alt={item.name_snapshot}
            title={item.name_snapshot}
            style={{ gridColumn: (index % 5) + 1, gridRow: index < 5 ? 1 : 3 }}
          />
        ))}
        <img
          className="shop-avatar-art"
          src={assetURL(avatar?.asset_key_snapshot ?? 'fox-v1')}
          alt={avatar?.name_snapshot ?? content.defaultAvatar}
        />
      </div>
    </section>
  );
}
