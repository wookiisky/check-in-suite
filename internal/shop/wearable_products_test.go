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
			_, err := f.Service.CreateProduct(context.Background(), f.Principal, core.ID(), shop.ProductInput{Type: shop.TypeWearable, Name: "默认服装", AssetKey: item.ThumbnailAssetKey, WearableKey: key, Enabled: true})
			requireShopCode(t, err, "INVALID_REQUEST")
		}
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
	if err = f.Service.DeleteProduct(ctx, f.Principal, deleted.ID, deleted.Version); err != nil {
		t.Fatal(err)
	}
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
