import type { Equipment, Purchase } from './types';
import { portraitType } from './helpers';
import content from './content.json';
import { categoryLabel, itemCategory } from './shop-categories';
import { ShopItemArtwork } from './ShopItemArtwork';

// 每次仅修改一个槽位或一个饰品，永久所有权来自订单快照。
export function Wardrobe({
  items,
  equipment,
  busy,
  onToggle,
  hasMore = false,
}: {
  items: Purchase[];
  equipment: Equipment;
  busy: boolean;
  hasMore?: boolean; // 尚有未读订单时不宣称库存为空。
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
      {items.length === 0 && !hasMore && !busy && <p>{content.emptyPurchases}</p>}
      <div className="shop-grid">
        {items.map((item) => {
          const kind = portraitType(item);
          if (!kind) return null;
          const equipped =
            (item.wearable_slot && equipment.wearables[item.wearable_slot]?.id === item.id) ||
            equipment.title?.id === item.id ||
            equipment.avatar?.id === item.id ||
            equipment.background?.id === item.id ||
            equipment.effects.some((effect) => effect.id === item.id) ||
            equipment.accessories.some((accessory) => accessory.id === item.id);
          const limitReached =
            kind === 'accessory' &&
            !item.wearable_slot &&
            !equipped &&
            equipment.accessories.length >= content.equipmentLimit;
          return (
            <article className="shop-card" key={item.id}>
              <ShopItemArtwork item={item} />
              <h3>{item.name_snapshot}</h3>
              <p className="shop-hint">{categoryLabel(itemCategory(item, true)!)}</p>
              <p>{item.description_snapshot}</p>
              {item.wearable_slot && <p className="shop-hint">{content.wearableHint}</p>}
              {kind === 'effect' && <p className="shop-hint">{content.effectHint}</p>}
              {kind === 'background' && <p className="shop-hint">{content.backgroundHint}</p>}
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
