package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// SeedIslandProducts adds eligible offers without replacing managed or soft-deleted rows.
func SeedIslandProducts(ctx context.Context, db *sql.DB, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var initialized bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM accounts)").Scan(&initialized); err != nil {
		return err
	}
	for _, item := range island.Catalog() {
		if item.AssetKey == "" || item.CatalogOnly || (initialized && !item.SeedExisting) {
			continue
		}
		kind := TypeIsland
		if asset, ok := assets.Get(item.AssetKey); ok && asset.Kind == assets.KindAccessory {
			kind = TypeAccessory
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", "island-offer-"+item.Key, kind, item.Name, item.AssetKey, "", item.CoinPrice, item.DiamondPrice, 1, now, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
