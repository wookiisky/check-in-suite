package shop

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// wearableOffer contains the first alternate outfit offers, separate from immutable geometry.
type wearableOffer struct {
	WearableKey  string `json:"wearable_key"`  // Explicit controlled definition.
	Name         string `json:"name"`          // Display name externalized with the starter offer.
	CoinPrice    int64  `json:"coin_price"`    // Initial coin price; later management edits are retained.
	DiamondPrice int64  `json:"diamond_price"` // Initial diamond price.
}

//go:embed wearable-products.json
var wearableProductsJSON []byte

// isDefaultWearable checks the character's declared free selection, never a naming convention.
func isDefaultWearable(item character.Wearable) bool {
	for _, body := range character.Definitions() {
		if body.Defaults.ForSlot(item.Slot) == item.Key {
			return true
		}
	}
	return false
}

// SeedWearableProducts adds only alternate clothes and preserves managed or deleted offers on retry.
func SeedWearableProducts(ctx context.Context, db *sql.DB, now int64) error {
	return seedCatalogAccounts(ctx, db, now, seedWearableProducts)
}

// seedWearableProducts only writes the selected account's offers.
func seedWearableProducts(ctx context.Context, db *sql.DB, accountID, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := seedWearableProductsInTx(ctx, tx, accountID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// seedWearableProductsInTx shares the account initialization transaction.
func seedWearableProductsInTx(ctx context.Context, tx *sql.Tx, accountID, now int64) error {
	var offers []wearableOffer
	if err := json.Unmarshal(wearableProductsJSON, &offers); err != nil {
		return err
	}
	for _, offer := range offers {
		item, ok := character.GetWearable(offer.WearableKey)
		if !ok || item.Empty || isDefaultWearable(item) {
			return fmt.Errorf("invalid alternate wearable offer %q", offer.WearableKey)
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO products(id,account_id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,'',?,?,1,?,?) ON CONFLICT(id) DO NOTHING", catalogProductID(accountID, "wearable-offer-"+item.Key), accountID, TypeWearable, offer.Name, item.ThumbnailAssetKey, item.Key, offer.CoinPrice, offer.DiamondPrice, now, now)
		if err != nil {
			return err
		}
	}
	// 包含自建报价和保留身份；只刷新图片及确认版本，不覆盖管理事实和成交快照。
	for _, item := range character.Wearables() {
		if item.Empty {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE products SET asset_key=?,version=version+1,updated_at=? WHERE account_id=? AND type=? AND wearable_key=? AND asset_key!=?`, item.ThumbnailAssetKey, now, accountID, TypeWearable, item.Key, item.ThumbnailAssetKey); err != nil {
			return err
		}
	}
	return nil
}
