package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestShopBuyChecksStableWearableOwnership proves alias quotes cannot charge a second time.
func TestShopBuyChecksStableWearableOwnership(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	defaults := map[string]bool{}
	for _, body := range character.Definitions() {
		for _, slot := range character.Slots() {
			defaults[body.Defaults.ForSlot(slot)] = true
		}
	}
	var wearable character.Wearable
	for _, item := range character.Wearables() {
		if !item.Empty && !defaults[item.Key] {
			wearable = item
			break
		}
	}
	if wearable.Key == "" {
		t.Fatal("missing non-default wearable")
	}
	input := productFixture{Type: shop.TypeWearable, Name: wearable.Name, AssetKey: wearable.ThumbnailAssetKey, WearableKey: wearable.Key, CoinPrice: 2, Enabled: true}
	first := createProduct(t, f, input)
	input.Name = "备用报价"
	second := createProduct(t, f, input)
	before := creditFixture(t, f, 10, 0)
	query := shop.ShopQuery{Group: "appearance", Category: string(wearable.Slot), Page: 1, Limit: 24}
	available, err := f.Service.BrowseShop(ctx, f.Principal, query)
	if err != nil || available.Total != 2 {
		t.Fatalf("available=%+v err=%v", available, err)
	}
	buy := shop.BuyInput{ProductID: first.ID, ExpectedProductVersion: first.Version, ExpectedWalletVersion: before.Version, RequireUnowned: true}
	receipt, err := f.Service.Buy(ctx, f.Principal, "first-wearable", buy)
	if err != nil {
		t.Fatal(err)
	}
	staleAlias := shop.BuyInput{ProductID: second.ID, ExpectedProductVersion: second.Version, ExpectedWalletVersion: before.Version, RequireUnowned: true}
	_, err = f.Contender.Buy(ctx, f.Principal, "wearable-alias", staleAlias)
	requireShopCode(t, err, "ALREADY_OWNED")

	replay, err := f.Contender.Buy(ctx, f.Principal, "first-wearable", buy)
	if err != nil || replay.Purchase.ID != receipt.Purchase.ID || readBalance(t, f).Coins != before.Coins-2 {
		t.Fatalf("replay=%+v receipt=%+v err=%v", replay, receipt, err)
	}
	remaining, err := f.Contender.BrowseShop(ctx, f.Principal, query)
	if err != nil || remaining.Total != 0 {
		t.Fatalf("remaining=%+v err=%v", remaining, err)
	}
}
