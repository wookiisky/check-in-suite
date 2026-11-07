package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// SeedSpatialProducts 初始化正式三维商品，重试不覆盖管理值或恢复已删除商品。
func SeedSpatialProducts(ctx context.Context, db *sql.DB, now int64) error {
	return seedCatalogAccounts(ctx, db, now, seedSpatialProducts)
}

// seedSpatialProducts only writes the selected account's offers.
func seedSpatialProducts(ctx context.Context, db *sql.DB, accountID, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := seedSpatialProductsInTx(ctx, tx, accountID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// seedSpatialProductsInTx shares the account initialization transaction.
func seedSpatialProductsInTx(ctx context.Context, tx *sql.Tx, accountID, now int64) error {
	for _, item := range island.SpatialCatalog() {
		if item.Free {
			continue
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO products(id,account_id,type,name,asset_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", catalogProductID(accountID, "spatial-offer-"+item.Key), accountID, TypeIsland, item.Name, item.ThumbnailAssetKey, "", item.CoinPrice, item.DiamondPrice, 1, now, now)
		if err != nil {
			return err
		}
	}
	// 自建报价也按稳定物件更新资源引用，不能因旧图退出当前目录而失去摆放能力。
	rows, err := tx.QueryContext(ctx, "SELECT id,asset_key FROM products WHERE account_id=? AND type=?", accountID, TypeIsland)
	if err != nil {
		return err
	}
	updates := map[string]string{}
	for rows.Next() {
		var id, artwork string
		if err := rows.Scan(&id, &artwork); err != nil {
			rows.Close()
			return err
		}
		if item, found := island.SpatialForThumbnail(artwork); found && artwork != item.ThumbnailAssetKey {
			updates[id] = item.ThumbnailAssetKey
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for id, artwork := range updates {
		if _, err := tx.ExecContext(ctx, "UPDATE products SET asset_key=?,version=version+1,updated_at=? WHERE account_id=? AND id=?", artwork, now, accountID, id); err != nil {
			return err
		}
	}
	return nil
}
