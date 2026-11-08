package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// A changed catalog binding invalidates a pending purchase and keeps commercial terms.
func TestWearableCatalogRevisionRefreshesPurchaseConfirmation(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := appearanceProduct("head", "barbarian")
	input.Name, input.CoinPrice = "管理名称", 7
	stock := int64(3)
	input.Stock = &stock
	before := configureDressUpOffer(t, f, input)
	if _, err := f.DB.Exec("UPDATE products SET catalog_revision='older-publication' WHERE id=?", before.ID); err != nil {
		t.Fatal(err)
	}
	now := f.Now.UnixMilli()
	for _, at := range []int64{now + 1, now + 2} {
		if err := shop.SeedWearableProducts(ctx, f.Other, at); err != nil {
			t.Fatal(err)
		}
	}
	balance := creditFixture(t, f, 20, 0)
	command := shop.BuyInput{ProductID: before.ID, ExpectedProductVersion: before.Version, ExpectedWalletVersion: balance.Version}
	_, err := f.Service.Buy(ctx, f.Principal, core.ID(), command)
	requireShopCode(t, err, "PRODUCT_CHANGED")
	command.ExpectedProductVersion++
	purchase, err := f.Service.Buy(ctx, f.Principal, "new-publication", command)
	if err != nil || purchase.Purchase.AssetKeySnapshot != before.AssetKey || purchase.Purchase.WearableKey != before.WearableKey ||
		purchase.Purchase.NameSnapshot != before.Name || purchase.Purchase.CoinPrice != 7 || purchase.Wallet.Coins != 13 {
		t.Fatalf("purchase=%+v err=%v", purchase, err)
	}
	if _, err := f.Service.UpdateProduct(ctx, f.Principal, before.ID, shop.ProductUpdate{
		ExpectedVersion: command.ExpectedProductVersion + 1,
		ProductTerms:    shop.ProductTerms{Name: "下架后的名称", CoinPrice: 9},
	}); err != nil {
		t.Fatal(err)
	}
	replay, err := f.Service.Buy(ctx, f.Principal, "new-publication", command)
	if err != nil || replay != purchase {
		t.Fatalf("purchase changed after rename and delisting: replay=%+v purchase=%+v err=%v", replay, purchase, err)
	}
}

// A failed catalog refresh leaves all account listings at their last published revisions.
func TestWearableArtworkRefreshFailureRollsBackSeed(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	first := configureDressUpOffer(t, f, appearanceProduct("head", "barbarian"))
	second := configureDressUpOffer(t, f, appearanceProduct("upper", "barbarian"))
	if _, err := f.DB.Exec("UPDATE products SET catalog_revision='older-publication' WHERE id IN (?,?)", first.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_wearable_binding BEFORE UPDATE OF catalog_revision ON products
		WHEN NEW.wearable_key='upper-barbarian-v1' BEGIN SELECT RAISE(ABORT,'catalog refresh failed'); END`); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedWearableProducts(ctx, f.Other, f.Now.UnixMilli()+1); err == nil {
		t.Fatal("catalog sync succeeded despite forced write failure")
	}
	var count int
	if err := f.DB.QueryRow("SELECT count(*) FROM products WHERE catalog_revision='older-publication' AND id IN (?,?)", first.ID, second.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("partial binding refresh: count=%d err=%v", count, err)
	}
}
