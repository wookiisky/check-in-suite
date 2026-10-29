import type { Equipment, Purchase } from './types';
import { assetURL } from './helpers';
import content from './content.json';

// 每次仅修改一个槽位或一个饰品，永久所有权来自订单快照。
export function Wardrobe({
  items,
  equipment,
  busy,
  onToggle,
}: {
  items: Purchase[];
  equipment: Equipment;
  busy: boolean;
  onToggle: (item: Purchase, equip: boolean) => void;
}) {
  return (
    <>
      <p>
        {content.equippedCount} {equipment.accessories.length} / {content.equipmentLimit}
      </p>
      {equipment.accessories.length >= content.equipmentLimit && (
        <p className="shop-hint">{content.accessoryLimit}</p>
      )}
      {items.length === 0 && <p>{content.emptyPurchases}</p>}
      <div className="shop-grid">
        {items.map((item) => {
          const equipped =
            equipment.title?.id === item.id ||
            equipment.avatar?.id === item.id ||
            equipment.background?.id === item.id ||
            equipment.effects.some((effect) => effect.id === item.id) ||
            equipment.accessories.some((accessory) => accessory.id === item.id);
          const limitReached =
            item.type_snapshot === 'accessory' &&
            !equipped &&
            equipment.accessories.length >= content.equipmentLimit;
          return (
            <article className="shop-card" key={item.id}>
              <img className="shop-item-art" src={assetURL(item.asset_key_snapshot, item.type_snapshot === 'effect')} alt="" />
              <h3>{item.name_snapshot}</h3>
              <p className="shop-hint">{content.types[item.type_snapshot]}</p>
              <p>{item.description_snapshot}</p>
              {item.type_snapshot === 'effect' && <p className="shop-hint">{content.effectHint}</p>}
              {item.type_snapshot === 'background' && <p className="shop-hint">{content.backgroundHint}</p>}
              {equipped && <p>{content.equipped}</p>}
              <button
                className={equipped ? 'secondary' : ''}
                disabled={busy || limitReached}
                onClick={() => onToggle(item, !equipped)}
                aria-label={`${equipped ? content.unequip : content.equip} ${item.name_snapshot}`}
              >
                {equipped ? content.unequip : content.equip}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
