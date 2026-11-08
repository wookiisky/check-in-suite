package shop_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// Concurrent direct purchases can acquire a stable wearable identity only once.
func TestShopBuyChecksStableWearableOwnership(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := appearanceProduct("head", "barbarian")
	input.CoinPrice = 2
	offer := configureDressUpOffer(t, f, input)
	wearable, ok := character.GetWearable(offer.WearableKey)
	if !ok {
		t.Fatal("missing wearable definition")
	}
	before := creditFixture(t, f, 10, 0)
	query := shop.ShopQuery{Group: "appearance", Category: string(wearable.Slot), Page: 1, Limit: 100}
	available, err := f.Service.BrowseShop(ctx, f.Principal, query)
	if err != nil || !slices.ContainsFunc(available.Items, func(item shop.Product) bool { return item.ID == offer.ID }) {
		t.Fatalf("available=%+v err=%v", available, err)
	}
	buy := shop.BuyInput{ProductID: offer.ID, ExpectedProductVersion: offer.Version, ExpectedWalletVersion: before.Version}
	results := compete(func() error {
		_, err := f.Service.Buy(ctx, f.Principal, "wearable-purchase-a", buy)
		return err
	}, func() error {
		_, err := f.Contender.Buy(ctx, f.Principal, "wearable-purchase-b", buy)
		return err
	})
	successes := 0
	for _, err := range results {
		if err == nil {
			successes++
			continue
		}
		var failure *core.Error
		if !errors.As(err, &failure) || (failure.Code != "WALLET_CHANGED" && failure.Code != "ALREADY_OWNED") {
			t.Fatalf("unexpected competing purchase error: %v", err)
		}
	}
	balance := readBalance(t, f)
	if successes != 1 || balance.Coins != before.Coins-2 {
		t.Fatalf("competing results=%v balance=%+v", results, balance)
	}
	buy.ExpectedWalletVersion = balance.Version
	_, err = f.Contender.Buy(ctx, f.Principal, "wearable-duplicate", buy)
	requireShopCode(t, err, "ALREADY_OWNED")
	remaining, err := f.Contender.BrowseShop(ctx, f.Principal, query)
	if err != nil || remaining.Total != available.Total-1 || slices.ContainsFunc(remaining.Items, func(item shop.Product) bool { return item.ID == offer.ID }) {
		t.Fatalf("remaining=%+v err=%v", remaining, err)
	}
}
