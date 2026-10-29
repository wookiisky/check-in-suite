package demo

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// seedPurchases preserves price snapshots, optional island capabilities and matching debits.
func seedPurchases(ctx context.Context, tx *sql.Tx, content settings, now time.Time, result *Result) error {
	placements := append([]island.Placement(nil), content.Placements...)
	for index, key := range content.OwnedAssets {
		var kind, name, description string
		var coins, diamonds int64
		if err := tx.QueryRowContext(ctx, `SELECT type,name,description,coin_price,diamond_price FROM products WHERE asset_key=?`, key).Scan(&kind, &name, &description, &coins, &diamonds); err != nil {
			return err
		}
		definition, hasIsland := island.ForAsset(key)
		itemKey := ""
		repeatable := false
		if hasIsland {
			itemKey = definition.Key
			repeatable = definition.Repeatable
		}
		status := "owned"
		if kind == string(assets.KindReward) {
			status = "pending"
		}
		id := core.ID()
		at := now.Add(-time.Duration(index+1) * time.Minute)
		_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, "demo-product-"+key, repeatable, itemKey, kind, name, description, key, coins, diamonds, status, at.UnixMilli())
		if err != nil {
			return err
		}
		if _, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: id, Coins: -coins, Diamonds: -diamonds, At: at}); err != nil {
			return err
		}
		result.Purchases++
		if kind == string(assets.KindReward) {
			// A separate order provides the redeemed state without inventing wallet adjustments.
			redeemedID := core.ID()
			_, err := tx.ExecContext(ctx, `INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,created_at) VALUES(?,?,?,?,?,?,?,?,'redeemed',?,?)`, redeemedID, "demo-product-"+key, kind, name, description, key, coins, diamonds, at.UnixMilli(), at.Add(-time.Hour).UnixMilli())
			if err != nil {
				return err
			}
			if _, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: redeemedID, Coins: -coins, Diamonds: -diamonds, At: at.Add(-time.Hour)}); err != nil {
				return err
			}
			result.Purchases++
		}
		// SQL identifiers are chosen only from controlled asset kinds, never from external input.
		switch assets.Kind(kind) {
		case assets.KindAvatar, assets.KindBackground, assets.KindTitle:
			if _, err := tx.ExecContext(ctx, "UPDATE accounts SET "+kind+"_purchase_id=? WHERE id=1", id); err != nil {
				return err
			}
		case assets.KindAccessory:
			if artwork, ok := assets.Get(key); ok && artwork.WearableSlot.Valid() {
				if _, err := tx.ExecContext(ctx, "UPDATE accounts SET "+string(artwork.WearableSlot)+"_purchase_id=? WHERE id=1", id); err != nil {
					return err
				}
				break
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO equipped_accessories(purchase_id,equipped_at) VALUES(?,?)`, id, now.UnixMilli()); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO accessory_layouts(purchase_id,x,y,size,layer) VALUES(?,?,?,?,?)`, id, 0.3+float64(index%3)*0.2, 0.6, 0.15, index+1); err != nil {
				return err
			}
		case assets.KindEffect:
			if _, err := tx.ExecContext(ctx, `INSERT INTO equipped_effects(purchase_id,equipped_at) VALUES(?,?)`, id, now.UnixMilli()); err != nil {
				return err
			}
		}
		if hasIsland {
			for index := range placements {
				if placements[index].ID == "" && placements[index].ItemKey == definition.Key {
					placements[index].ID = id
					break
				}
			}
		}
	}
	layout, err := json.Marshal(placements)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO island_state(id,version,placements) VALUES(1,1,?)`, string(layout))
	return err
}
