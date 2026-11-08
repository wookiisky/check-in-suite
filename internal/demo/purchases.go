package demo

import (
	"context"
	"database/sql"
	"fmt"
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
	// 演示装扮按目录身份查报价，缩略图只用于成交快照。
	type ownedOffer struct {
		assetKey string             // 成交素材版本。
		wearable character.Wearable // 有稳定身份时按穿戴定义查报价。
	}
	offers := make([]ownedOffer, 0, len(content.OwnedWearables)+len(content.OwnedAssets))
	for _, key := range content.OwnedWearables {
		wearable, found := character.GetWearable(key)
		if !found {
			return fmt.Errorf("演示服装 %q 未登记", key)
		}
		offers = append(offers, ownedOffer{assetKey: wearable.ThumbnailAssetKey, wearable: wearable})
	}
	for _, key := range content.OwnedAssets {
		offers = append(offers, ownedOffer{assetKey: key})
	}
	for index, offer := range offers {
		var productID, kind, name, description string
		var coins, diamonds int64
		condition, key := "asset_key=?", offer.assetKey
		if offer.wearable.Key != "" {
			condition, key = "type='wearable' AND wearable_key=?", offer.wearable.Key
		}
		if err := tx.QueryRowContext(ctx, `SELECT id,type,name,description,coin_price,diamond_price FROM products WHERE account_id=1 AND `+condition, key).Scan(&productID, &kind, &name, &description, &coins, &diamonds); err != nil {
			return fmt.Errorf("读取演示商品 %q: %w", key, err)
		}
		definition, hasIsland := island.SpatialForThumbnail(offer.assetKey)
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
		_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, productID, repeatable, itemKey, offer.wearable.Key, kind, name, description, offer.assetKey, coins, diamonds, status, at.UnixMilli())
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
			_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,created_at) VALUES(?,?,?,?,?,?,?,?,'redeemed',?,?)`, redeemedID, productID, kind, name, description, offer.assetKey, coins, diamonds, at.UnixMilli(), at.Add(-time.Hour).UnixMilli())
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
		if offer.wearable.Key != "" {
			switch offer.wearable.Slot {
			case character.SlotFace:
				appearance.FaceWearableKey = &offer.wearable.Key
			case character.SlotBack:
				appearance.BackWearableKey = &offer.wearable.Key
			case character.SlotHead:
				appearance.HeadWearableKey = &offer.wearable.Key
			case character.SlotUpper:
				appearance.UpperWearableKey = &offer.wearable.Key
			case character.SlotLower:
				appearance.LowerWearableKey = &offer.wearable.Key
			case character.SlotShoes:
				appearance.ShoesWearableKey = &offer.wearable.Key
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,face_wearable_key,head_wearable_key,upper_wearable_key,lower_wearable_key,shoes_wearable_key,back_wearable_key) VALUES(1,?,?,?,?,?,?,?,?)`, appearance.Version, appearance.CharacterKey, appearance.FaceWearableKey, appearance.HeadWearableKey, appearance.UpperWearableKey, appearance.LowerWearableKey, appearance.ShoesWearableKey, appearance.BackWearableKey); err != nil {
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
