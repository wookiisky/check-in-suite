package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/character"
)

// purchaseFacets supplies all owned source options without loading order descriptions or model bytes.
func purchaseFacets(ctx context.Context, tx *sql.Tx) (*ProductFacets, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT asset_key_snapshot,character_key_snapshot FROM purchases`)
	if err != nil {
		return nil, err
	}
	items := []Product{}
	for rows.Next() {
		var assetKey, bodyKey string
		if err := rows.Scan(&assetKey, &bodyKey); err != nil {
			rows.Close()
			return nil, err
		}
		item := Product{}
		if asset, ok := assets.Get(assetKey); ok {
			item.Provider, item.PackKey, item.PackName = asset.Provider, asset.PackKey, asset.PackName
		}
		if body, ok := character.Get(bodyKey); ok {
			item.Provider, item.PackKey = body.Provider, body.PackKey
		}
		items = append(items, item)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	return productFacets(items), nil
}
