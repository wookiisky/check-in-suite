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
	body, ok := character.Get(item.CharacterKey)
	if !ok {
		return false
	}
	switch item.Slot {
	case character.SlotHair:
		return body.Defaults.Hair == item.Key
	case character.SlotUpper:
		return body.Defaults.Upper == item.Key
	case character.SlotLower:
		return body.Defaults.Lower == item.Key
	case character.SlotShoes:
		return body.Defaults.Shoes == item.Key
	default:
		return false
	}
}

// SeedWearableProducts adds only alternate clothes and preserves managed or deleted offers on retry.
func SeedWearableProducts(ctx context.Context, db *sql.DB, now int64) error {
	var offers []wearableOffer
	if err := json.Unmarshal(wearableProductsJSON, &offers); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, offer := range offers {
		item, ok := character.GetWearable(offer.WearableKey)
		if !ok || isDefaultWearable(item) {
			return fmt.Errorf("invalid alternate wearable offer %q", offer.WearableKey)
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,'',?,?,1,?,?) ON CONFLICT(id) DO NOTHING", "wearable-offer-"+item.Key, TypeWearable, offer.Name, item.ThumbnailAssetKey, item.Key, offer.CoinPrice, offer.DiamondPrice, now, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
