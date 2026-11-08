package shop

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// wearableOffer associates launch terms with one published wearable.
type wearableOffer struct {
	WearableKey string `json:"wearable_key"` // Stable wearable identity.
	dressUpOfferDefaults
}

//go:embed wearable-products.json
var wearableProductsJSON []byte

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
	if err := SeedWearableProductsInTx(ctx, tx, accountID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// SeedWearableProductsInTx shares the account initialization transaction.
func SeedWearableProductsInTx(ctx context.Context, tx *sql.Tx, accountID, now int64) error {
	var offers []wearableOffer
	if err := json.Unmarshal(wearableProductsJSON, &offers); err != nil {
		return err
	}
	defaults := make(map[string]dressUpOfferDefaults, len(offers))
	for _, offer := range offers {
		defaults[offer.WearableKey] = offer.dressUpOfferDefaults
	}
	var bindings []dressUpOfferBinding
	for _, wearable := range character.Wearables() {
		if wearable.Sellable {
			bindings = append(bindings, dressUpOfferBinding{Key: wearable.Key, Name: wearable.Name, Thumbnail: wearable.ThumbnailAssetKey, Model: wearable.ModelAssetKey})
		}
	}
	return syncDressUpOffers(ctx, tx, accountID, now, TypeWearable, bindings, defaults)
}
