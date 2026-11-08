package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// A catalog body has one offer per account, with artwork resolved at read time.
func TestAccountCatalogDressUpBinding(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := catalogCharacterProduct(t)
	body, ok := character.Get(input.CharacterKey)
	if !ok {
		t.Fatal("missing catalog body")
	}
	if err := f.Accounts.Initialize(ctx, "catalog-price", "另一位", "other-login-password", "other-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.Accounts.Login(ctx, "catalog-price", "other-login-password")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Accounts.Unlock(ctx, other, "other-management-password"); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCharacterProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var storedAsset string
	if err := f.DB.QueryRowContext(ctx, "SELECT asset_key FROM products WHERE account_id=? AND character_key=?", f.Principal.AccountID, body.Key).Scan(&storedAsset); err != nil || storedAsset != "" {
		t.Fatalf("catalog offer persisted artwork %q, err=%v", storedAsset, err)
	}
	result, err := f.Service.ListProductsPage(ctx, f.Principal, true, shop.ProductQuery{Type: shop.TypeCharacter, Limit: 10})
	if err != nil || len(result.Items) != 1 || result.Items[0].AssetKey != body.ThumbnailAssetKey {
		t.Fatalf("catalog projection=%+v err=%v", result, err)
	}
	first := result.Items[0]
	input.Name, input.CoinPrice, input.DiamondPrice, input.Enabled = "账户自定商品名", 17, 3, false
	stock := int64(2)
	input.Stock = &stock
	if _, err := f.Service.UpdateProduct(ctx, f.Principal, first.ID, shop.ProductUpdate{
		ExpectedVersion: first.Version, ProductTerms: input.terms(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCharacterProducts(ctx, f.Other, f.Now.UnixMilli()+1); err != nil {
		t.Fatal(err)
	}
	ours, err := f.Service.ListProducts(ctx, f.Principal, true)
	if err != nil || len(ours.Items) != 1 || ours.Items[0].ID != first.ID {
		t.Fatalf("first account=%+v err=%v", ours, err)
	}
	current := ours.Items[0]
	if current.Version != first.Version+1 || current.Name != input.Name || current.CoinPrice != 17 || current.DiamondPrice != 3 ||
		current.Enabled || current.Stock == nil || *current.Stock != stock {
		t.Fatalf("first account terms=%+v", current)
	}
	theirs, err := f.Service.ListProducts(ctx, other, true)
	if err != nil || len(theirs.Items) != 1 {
		t.Fatalf("second account=%+v err=%v", theirs, err)
	}
	independent := theirs.Items[0]
	if independent.ID == first.ID || independent.CharacterKey != first.CharacterKey || independent.Name != first.Name ||
		independent.CoinPrice != first.CoinPrice || independent.DiamondPrice != first.DiamondPrice || !independent.Enabled || independent.Stock != nil {
		t.Fatalf("first account edit leaked to second: %+v", independent)
	}
	_, err = f.Service.CreateProduct(ctx, f.Principal, core.ID(), input.createInput())
	requireShopCode(t, err, "INVALID_REQUEST")
}

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
