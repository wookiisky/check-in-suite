package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// SeedSpatialProducts 初始化正式三维商品，重试不覆盖管理值或恢复已删除商品。
func SeedSpatialProducts(ctx context.Context, db *sql.DB, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range island.SpatialCatalog() {
		if item.Free {
			continue
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", "spatial-offer-"+item.Key, TypeIsland, item.Name, item.ThumbnailAssetKey, "", item.CoinPrice, item.DiamondPrice, 1, now, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
