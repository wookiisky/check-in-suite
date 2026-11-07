package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestAccountCatalogSeedingPreservesOtherQuotes proves fresh accounts get independent configurable prices.
func TestAccountCatalogSeedingPreservesOtherQuotes(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := f.Accounts.Initialize(ctx, "second-catalog", "另一位", "second-login-password", "second-management-password"); err != nil {
		t.Fatal(err)
	}
	var secondID int64
	if err := f.DB.QueryRowContext(ctx, "SELECT id FROM accounts WHERE username=?", "second-catalog").Scan(&secondID); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCatalogForAccount(ctx, f.DB, f.Principal.AccountID, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.ExecContext(ctx, "UPDATE products SET coin_price=12345 WHERE account_id=?", f.Principal.AccountID); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCatalogForAccount(ctx, f.DB, secondID, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCharacterProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCatalogForAccount(ctx, f.DB, secondID, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var firstCount, secondCount, overwritten int
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products WHERE account_id=?", f.Principal.AccountID).Scan(&firstCount); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products WHERE account_id=?", secondID).Scan(&secondCount); err != nil {
		t.Fatal(err)
	}
	if firstCount == 0 || firstCount != secondCount {
		t.Fatalf("catalog counts=%d,%d", firstCount, secondCount)
	}
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products WHERE account_id=? AND coin_price!=12345", f.Principal.AccountID).Scan(&overwritten); err != nil || overwritten != 0 {
		t.Fatalf("configured prices changed=%d error=%v", overwritten, err)
	}
}
