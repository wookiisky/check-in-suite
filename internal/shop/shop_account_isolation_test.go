package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestAccountsKeepShopOwnershipSeparate proves real persisted quotes and purchases stay private.
func TestAccountsKeepShopOwnershipSeparate(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := f.Accounts.Initialize(ctx, "second-shop", "另一位", "second-login-password", "second-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.Accounts.Login(ctx, "second-shop", "second-login-password")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Accounts.Unlock(ctx, second, "second-management-password"); err != nil {
		t.Fatal(err)
	}
	creditFixture(t, f, 10, 0)
	input := productInput(shop.TypeTitle)
	input.CoinPrice = 3
	firstOffer := createProduct(t, f, input)
	bought, err := f.Service.Buy(ctx, f.Principal, "shared-key", shop.BuyInput{ProductID: firstOffer.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 2})
	if err != nil {
		t.Fatal(err)
	}
	products, err := f.Service.ListProducts(ctx, second, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(products.Items) != 0 {
		t.Fatalf("second account sees first quotes: %+v", products.Items)
	}
	purchases, err := f.Service.ListPurchases(ctx, second, shop.PurchaseQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(purchases.Items) != 0 {
		t.Fatalf("second account sees first orders: %+v", purchases.Items)
	}
	_, err = f.Service.Buy(ctx, second, core.ID(), shop.BuyInput{ProductID: firstOffer.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 1})
	requireShopCode(t, err, "NOT_FOUND")
	_, err = f.Service.SetTitle(ctx, second, &bought.Purchase.ID)
	requireShopCode(t, err, "NOT_FOUND")
	_, err = f.Service.UpdateProduct(ctx, second, firstOffer.ID, shop.ProductUpdate{ProductTerms: input.terms(), ExpectedVersion: firstOffer.Version})
	requireShopCode(t, err, "NOT_FOUND")
	paged, err := f.Service.ListProductsPage(ctx, second, true, shop.ProductQuery{Limit: 10})
	if err != nil || len(paged.Items) != 0 {
		t.Fatalf("paged catalog leaked: %+v, %v", paged, err)
	}
	secondOffer, err := f.Service.CreateProduct(ctx, second, "shared-key", catalogCharacterProduct(t).createInput())
	if err != nil {
		t.Fatal(err)
	}
	if secondOffer.ID == firstOffer.ID {
		t.Fatal("idempotency receipt crossed accounts")
	}
	if _, err := f.Service.Buy(ctx, second, "shared-key", shop.BuyInput{ProductID: secondOffer.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 1}); err != nil {
		t.Fatal(err)
	}
	var firstCoins, secondCoins int64
	if err := f.DB.QueryRowContext(ctx, "SELECT coins FROM wallets WHERE account_id=?", f.Principal.AccountID).Scan(&firstCoins); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRowContext(ctx, "SELECT coins FROM wallets WHERE account_id=?", second.AccountID).Scan(&secondCoins); err != nil {
		t.Fatal(err)
	}
	if firstCoins != 7 || secondCoins != 0 {
		t.Fatalf("balances crossed accounts: %d, %d", firstCoins, secondCoins)
	}
}

// TestAccountsSaveIndependentAppearance proves the first save does not consume another user's version.
func TestAccountsSaveIndependentAppearance(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := f.Accounts.Initialize(ctx, "second-appearance", "另一位", "second-login-password", "second-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.Accounts.Login(ctx, "second-appearance", "second-login-password")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	firstState, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: firstState.CharacterKey}); err != nil {
		t.Fatal(err)
	}
	secondState, err := f.Service.Appearance(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if secondState.Version != 1 || len(secondState.Inventory) != 0 {
		t.Fatalf("other appearance leaked: %+v", secondState)
	}
	if _, err := f.Service.SaveAppearance(ctx, second, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: secondState.CharacterKey}); err != nil {
		t.Fatal(err)
	}
	var states int
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM appearance_state").Scan(&states); err != nil || states != 2 {
		t.Fatalf("appearance rows=%d error=%v", states, err)
	}
}
