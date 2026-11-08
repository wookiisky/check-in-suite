package shop

import (
	"context"
	"database/sql"
	"strconv"
)

// catalogProductID keeps seeded quote identities stable within each account.
func catalogProductID(accountID int64, id string) string {
	if accountID == 1 {
		return id
	}
	return "account-" + strconv.FormatInt(accountID, 10) + "-" + id
}

// seedCatalogAccounts updates every configured account and supports the initial empty installation.
func seedCatalogAccounts(ctx context.Context, db *sql.DB, now int64, seed func(context.Context, *sql.DB, int64, int64) error) error {
	rows, err := db.QueryContext(ctx, "SELECT id FROM accounts ORDER BY id")
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		ids = append(ids, 1)
	}
	for _, id := range ids {
		if err := seed(ctx, db, id, now); err != nil {
			return err
		}
	}
	return nil
}

// SeedCatalogForAccount supplies independent offers without overwriting configured or deleted rows.
func SeedCatalogForAccount(ctx context.Context, db *sql.DB, accountID, now int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := SeedCatalogInTx(ctx, tx, accountID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// SeedCatalogInTx creates initial offers atomically with the account and its empty wallet.
func SeedCatalogInTx(ctx context.Context, tx *sql.Tx, accountID, now int64) error {
	for _, seed := range []func(context.Context, *sql.Tx, int64, int64) error{seedCharacterProductsInTx, SeedWearableProductsInTx, seedSpatialProductsInTx, seedSceneProductsInTx} {
		if err := seed(ctx, tx, accountID, now); err != nil {
			return err
		}
	}
	return nil
}
