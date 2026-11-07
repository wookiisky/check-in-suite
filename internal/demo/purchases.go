package demo

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// seedPurchases 在同一事务建立真实订单、账务、称号、六槽外观和厘米布局。
func seedPurchases(ctx context.Context, tx *sql.Tx, content settings, now time.Time, result *Result) error {
	layout := island.SpatialDefaultLayout()
	placements := append(layout.Placements, content.Placements...)
	appearance := shop.AppearanceState{Version: 1, CharacterKey: character.DefaultCharacterKey}
	for index, key := range content.OwnedAssets {
		var productID, kind, name, description, wearableKey string
		var coins, diamonds int64
		if err := tx.QueryRowContext(ctx, `SELECT id,type,name,description,coin_price,diamond_price,wearable_key FROM products WHERE asset_key=?`, key).Scan(&productID, &kind, &name, &description, &coins, &diamonds, &wearableKey); err != nil {
			return err
		}
		definition, hasIsland := island.SpatialForThumbnail(key)
		itemKey, repeatable := "", false
		if hasIsland {
			itemKey, repeatable = definition.Key, definition.Repeatable
		}
		status := shop.StatusOwned
		if kind == shop.TypeReward {
			status = shop.StatusPending
		}
		id := core.ID()
		at := now.Add(-time.Duration(index+1) * time.Minute)
		_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, productID, repeatable, itemKey, wearableKey, kind, name, description, key, coins, diamonds, status, at.UnixMilli())
		if err != nil {
			return err
		}
		if _, err := wallet.Apply(ctx, tx, 1, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: id, Coins: -coins, Diamonds: -diamonds, At: at}); err != nil {
			return err
		}
		result.Purchases++
		if kind == shop.TypeReward {
			// 兑换订单单独扣款，保留待兑换与已兑换两种事实。
			redeemedID := core.ID()
			_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,created_at) VALUES(?,?,?,?,?,?,?,?,'redeemed',?,?)`, redeemedID, productID, kind, name, description, key, coins, diamonds, at.UnixMilli(), at.Add(-time.Hour).UnixMilli())
			if err != nil {
				return err
			}
			if _, err := wallet.Apply(ctx, tx, 1, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: redeemedID, Coins: -coins, Diamonds: -diamonds, At: at.Add(-time.Hour)}); err != nil {
				return err
			}
			result.Purchases++
		}
		if kind == shop.TypeTitle {
			if _, err := tx.ExecContext(ctx, `UPDATE accounts SET title_purchase_id=? WHERE id=1`, id); err != nil {
				return err
			}
		}
		if kind == shop.TypeWearable {
			wearable, found := character.GetWearable(wearableKey)
			if !found {
				return core.Invalid("wearable_key", "INVALID_VALUE")
			}
			switch wearable.Slot {
			case character.SlotFace:
				appearance.FacePurchaseID = &id
			case character.SlotBack:
				appearance.BackPurchaseID = &id
			case character.SlotHead:
				appearance.HeadPurchaseID = &id
			case character.SlotUpper:
				appearance.UpperPurchaseID = &id
			case character.SlotLower:
				appearance.LowerPurchaseID = &id
			case character.SlotShoes:
				appearance.ShoesPurchaseID = &id
			}
		}
		if hasIsland {
			for position := range placements {
				if placements[position].InstanceID == "" && placements[position].ItemKey == definition.Key {
					placements[position].InstanceID = id
					break
				}
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,face_purchase_id,head_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id,back_purchase_id) VALUES(1,?,?,?,?,?,?,?,?)`, appearance.Version, appearance.CharacterKey, appearance.FacePurchaseID, appearance.HeadPurchaseID, appearance.UpperPurchaseID, appearance.LowerPurchaseID, appearance.ShoesPurchaseID, appearance.BackPurchaseID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO island_scene_states(scene_key,version,environment_key) VALUES(?,1,?)`, layout.SceneKey, layout.EnvironmentKey); err != nil {
		return err
	}
	for index, placement := range placements {
		if _, err := tx.ExecContext(ctx, `INSERT INTO island_scene_placements(instance_id,scene_key,position_index,item_key,space,x_cm,z_cm,rotation) VALUES(?,?,?,?,?,?,?,?)`, placement.InstanceID, layout.SceneKey, index, placement.ItemKey, placement.Space, placement.XCM, placement.ZCM, placement.Rotation); err != nil {
			return err
		}
	}
	return nil
}
