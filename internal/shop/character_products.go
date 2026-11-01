package shop

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// characterPrices contains the configurable initial offer for newly installed characters.
type characterPrices struct {
	Coins    int64 `json:"coin_price"`    // Initial coin price, retained separately from immutable geometry.
	Diamonds int64 `json:"diamond_price"` // Initial diamond price.
}

//go:embed character-pricing.json
var characterPricesJSON []byte

// SeedCharacterProducts adds permanent character offers without changing managed or deleted rows.
func SeedCharacterProducts(ctx context.Context, db *sql.DB, now int64) error {
	var price characterPrices
	if err := json.Unmarshal(characterPricesJSON, &price); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, body := range character.Definitions() {
		if body.Key == character.DefaultCharacterKey {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO products(id,type,name,asset_key,character_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,'',?,?,1,?,?) ON CONFLICT(id) DO NOTHING`, "character-offer-"+body.Key, TypeCharacter, body.Name, body.ThumbnailAssetKey, body.Key, price.Coins, price.Diamonds, now, now); err != nil {
			return err
		}
		// 只推进相同人物的图片版本，报价及历史成交快照保持原样。
		if _, err := tx.ExecContext(ctx, `UPDATE products SET asset_key=?,version=version+1,updated_at=? WHERE type=? AND character_key=? AND asset_key!=?`, body.ThumbnailAssetKey, now, TypeCharacter, body.Key, body.ThumbnailAssetKey); err != nil {
			return err
		}
	}
	return tx.Commit()
}
