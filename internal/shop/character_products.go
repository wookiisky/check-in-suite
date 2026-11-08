package shop

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"

	"github.com/wookiisky/check-in-suite/internal/character"
)

//go:embed character-pricing.json
var characterPricesJSON []byte

// SeedCharacterProducts adds permanent character offers without changing managed or deleted rows.
func SeedCharacterProducts(ctx context.Context, db *sql.DB, now int64) error {
	return seedCatalogAccounts(ctx, db, now, seedCharacterProducts)
}

// seedCharacterProducts only writes the selected account's offers.
func seedCharacterProducts(ctx context.Context, db *sql.DB, accountID, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := seedCharacterProductsInTx(ctx, tx, accountID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// seedCharacterProductsInTx shares the account initialization transaction.
func seedCharacterProductsInTx(ctx context.Context, tx *sql.Tx, accountID, now int64) error {
	var defaults map[string]dressUpOfferDefaults
	if err := json.Unmarshal(characterPricesJSON, &defaults); err != nil {
		return err
	}
	var bindings []dressUpOfferBinding
	for _, body := range character.Definitions() {
		if body.Sellable {
			bindings = append(bindings, dressUpOfferBinding{Key: body.Key, Name: body.Name, Thumbnail: body.ThumbnailAssetKey, Model: body.ModelAssetKey})
		}
	}
	return syncDressUpOffers(ctx, tx, accountID, now, TypeCharacter, bindings, defaults)
}
