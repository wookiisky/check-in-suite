package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 默认装备属于身体定义，不应再以商品报价出售。
func TestDefaultWearableCannotBeSold(t *testing.T) {
	f := newShopFixture(t)
	for _, body := range character.Definitions() {
		for _, slot := range character.Slots() {
			key := body.Defaults.ForSlot(slot)
			item, ok := character.GetWearable(key)
			if !ok {
				t.Fatal(key)
			}
			_, err := f.Service.CreateProduct(context.Background(), f.Principal, core.ID(), productFixture{Name: "默认服装", AssetKey: item.ThumbnailAssetKey, Enabled: true}.createInput())
			requireShopCode(t, err, "INVALID_REQUEST")
		}
	}
}

// 基础人形免费使用背心和内裤，原套装的三件衣物各自购买后才能穿戴。
func TestHumanDefaultsAndPaidFormerOutfit(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	initial, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	defaultsByBody := make(map[string][3]string)
	for _, body := range initial.Characters {
		defaultsByBody[body.Key] = [3]string{body.Defaults.Upper, body.Defaults.Lower, body.Defaults.Shoes}
	}
	if got := defaultsByBody[initial.DefaultCharacterKey]; got != [3]string{"upper-human-tank-v1", "lower-human-briefs-v1", "shoes-none-v1"} {
		t.Fatalf("human defaults = %q", got)
	}
	if got := defaultsByBody["kaykit-skeleton-v1"]; got != [3]string{"upper-none-v1", "skeleton-minion-lower-v1", "shoes-none-v1"} {
		t.Fatalf("skeleton defaults = %q", got)
	}
	if err := shop.SeedWearableProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	offers, err := f.Service.ListProducts(ctx, f.Principal, false)
	if err != nil {
		t.Fatal(err)
	}
	offerByKey := make(map[string]shop.Product)
	for _, offer := range offers.Items {
		offerByKey[offer.WearableKey] = offer
	}
	upper, lower, shoes := "upper-rogue-v1", "lower-rogue-v1", "shoes-rogue-v1"
	for _, input := range []shop.SaveAppearanceInput{
		{UpperFreeWearableKey: &upper},
		{LowerFreeWearableKey: &lower},
		{ShoesFreeWearableKey: &shoes},
	} {
		input.ExpectedVersion, input.CharacterKey = initial.Version, initial.CharacterKey
		_, err := f.Service.SaveAppearance(ctx, f.Principal, input)
		requireShopCode(t, err, "INVALID_EQUIPMENT")
	}

	creditFixture(t, f, 75, 0)
	purchases := make(map[string]*string)
	for key, price := range map[string]int64{upper: 35, lower: 25, shoes: 15} {
		offer, exists := offerByKey[key]
		if !exists || offer.Type != shop.TypeWearable || offer.CoinPrice != price || offer.DiamondPrice != 0 {
			t.Fatalf("unexpected offer for %s: %+v", key, offer)
		}
		purchase := buyProduct(t, f, offer).Purchase
		if purchase.WearableKey != key {
			t.Fatalf("purchase wearable = %s, want %s", purchase.WearableKey, key)
		}
		purchases[key] = &purchase.ID
	}
	if balance := readBalance(t, f); balance.Coins != 0 || balance.Diamonds != 0 {
		t.Fatalf("balance after purchases = %+v", balance)
	}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{
		ExpectedVersion: initial.Version, CharacterKey: initial.CharacterKey,
		UpperPurchaseID: purchases[upper], LowerPurchaseID: purchases[lower], ShoesPurchaseID: purchases[shoes],
	})
	if err != nil || saved.UpperPurchaseID == nil || saved.LowerPurchaseID == nil || saved.ShoesPurchaseID == nil || len(saved.Inventory) != 3 {
		t.Fatalf("purchased outfit could not be saved: %+v, %v", saved, err)
	}
}

// 首批商品只包含替代款，重复启动保留报价、上下架和删除事实。
func TestSeedWearableProductsPreservesManagedOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedWearableProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	offers, err := f.Service.ListProducts(ctx, f.Principal, true)
	if err != nil || len(offers.Items) < 5 {
		t.Fatalf("offers=%+v %v", offers, err)
	}
	for _, offer := range offers.Items {
		if offer.Type != shop.TypeWearable || offer.WearableKey == "" || offer.ID != "wearable-offer-"+offer.WearableKey {
			t.Fatalf("bad seed %+v", offer)
		}
		item, ok := character.GetWearable(offer.WearableKey)
		if !ok {
			t.Fatal(offer.WearableKey)
		}
		body, _ := character.Get(item.CharacterKey)
		for _, slot := range character.Slots() {
			key := body.Defaults.ForSlot(slot)
			if key == item.Key {
				t.Fatal("default garment seeded")
			}
		}
	}
	managed := offers.Items[0]
	if _, err = f.DB.Exec("UPDATE products SET coin_price=77,enabled=0,version=5 WHERE id=?", managed.ID); err != nil {
		t.Fatal(err)
	}
	deleted := offers.Items[1]
	retireHistoricalProduct(t, f, deleted.ID)
	if err = shop.SeedWearableProducts(ctx, f.Other, f.Now.UnixMilli()+1); err != nil {
		t.Fatal(err)
	}
	var count, price, enabled, version int
	if err = f.DB.QueryRow("SELECT COUNT(*) FROM products").Scan(&count); err != nil || count != len(offers.Items) {
		t.Fatalf("count=%d %v", count, err)
	}
	if err = f.DB.QueryRow("SELECT coin_price,enabled,version FROM products WHERE id=?", managed.ID).Scan(&price, &enabled, &version); err != nil || price != 77 || enabled != 0 || version != 5 {
		t.Fatalf("managed %d/%d/%d %v", price, enabled, version, err)
	}
	var stillDeleted bool
	if err = f.DB.QueryRow("SELECT deleted_at IS NOT NULL FROM products WHERE id=?", deleted.ID).Scan(&stillDeleted); err != nil || !stillDeleted {
		t.Fatalf("deleted resurrected: %v", err)
	}
}
