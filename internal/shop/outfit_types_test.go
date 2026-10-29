package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestBackgroundPermanentOwnershipAndIndependentSlot preserves purchased scenes after product deletion.
func TestBackgroundPermanentOwnershipAndIndependentSlot(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	product := createProduct(t, f, productInput("background"))
	purchase := buyProduct(t, f, product).Purchase
	avatar := buyProduct(t, f, createProduct(t, f, productInput("avatar"))).Purchase
	if _, err := f.Service.SetSlot(ctx, f.Principal, "avatar", &avatar.ID); err != nil {
		t.Fatal(err)
	}
	result, err := f.Service.SetSlot(ctx, f.Principal, "background", &purchase.ID)
	if err != nil || result.Background == nil || result.Background.ID != purchase.ID || result.Avatar == nil || result.Avatar.ID != avatar.ID {
		t.Fatalf("background=%+v %v", result, err)
	}
	_, err = f.Service.Buy(ctx, f.Principal, "duplicate-background", shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: readBalance(t, f).Version})
	requireShopCode(t, err, "ALREADY_OWNED")
	if err = f.Service.DeleteProduct(ctx, f.Principal, product.ID, product.Version); err != nil {
		t.Fatal(err)
	}
	result, err = f.Contender.Equipment(ctx, f.Principal)
	if err != nil || result.Background == nil || result.Background.AssetKeySnapshot != "background-meadow-v1" {
		t.Fatalf("lost deleted product snapshot: %+v %v", result, err)
	}
	result, err = f.Service.SetSlot(ctx, f.Principal, "background", nil)
	if err != nil || result.Background != nil || result.Avatar.ID != avatar.ID {
		t.Fatalf("reset changed other slots: %+v %v", result, err)
	}
	_, err = f.Service.SetSlot(ctx, f.Principal, "background", &avatar.ID)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
}

// TestEffectsAreIndependentPermanentOverlays enforces ownership without the accessory count or layout model.
func TestEffectsAreIndependentPermanentOverlays(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	accessory := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	if _, err := f.Service.SetAccessory(ctx, f.Principal, accessory.ID, true); err != nil {
		t.Fatal(err)
	}
	var first shop.Purchase
	for i := 0; i < 11; i++ {
		item := buyProduct(t, f, createProduct(t, f, productInput("effect"))).Purchase
		if i == 0 {
			first = item
		}
		if _, err := f.Service.SetEffect(ctx, f.Principal, item.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.Service.SetEffect(ctx, f.Principal, first.ID, true); err != nil {
		t.Fatal(err)
	}
	result, err := f.Contender.Equipment(ctx, f.Principal)
	if err != nil || len(result.Effects) != 11 || len(result.Accessories) != 1 || len(result.AccessoryLayouts) != 1 {
		t.Fatalf("overlays=%+v %v", result, err)
	}
	_, err = f.Service.SetAccessory(ctx, f.Principal, first.ID, true)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	_, err = f.Service.SetEffect(ctx, f.Principal, accessory.ID, true)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	_, err = f.Service.SetAccessoryLayout(ctx, f.Principal, first.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .2})
	requireShopCode(t, err, "EQUIPMENT_CHANGED")
	for i := 0; i < 2; i++ {
		if _, err := f.Service.SetEffect(ctx, f.Principal, first.ID, false); err != nil {
			t.Fatal(err)
		}
	}
	result, err = f.Contender.Equipment(ctx, f.Principal)
	if err != nil || len(result.Effects) != 10 || len(result.Accessories) != 1 {
		t.Fatalf("remove=%+v %v", result, err)
	}
	items, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: "effect"})
	if err != nil || len(items.Items) != 11 {
		t.Fatalf("ownership lost: %+v %v", items, err)
	}
}

// TestLayoutSaveCompetesWithTargetUnequip never restores a stale target or partially saves geometry.
func TestLayoutSaveCompetesWithTargetUnequip(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	first := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	second := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	for _, item := range []shop.Purchase{first, second} {
		if _, err := f.Service.SetAccessory(ctx, f.Principal, item.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	before, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	results := compete(func() error {
		_, err := f.Service.SetAccessoryLayout(ctx, f.Principal, first.ID, shop.AccessoryLayoutInput{X: .4, Y: .6, Size: .3, BeforeID: &second.ID})
		return err
	}, func() error {
		_, err := f.Contender.SetAccessory(ctx, f.Principal, second.ID, false)
		return err
	})
	if results[1] != nil {
		t.Fatal(results)
	}
	result, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || len(result.Accessories) != 1 || result.Accessories[0].ID != first.ID {
		t.Fatalf("stale target restored: %+v %v", result, err)
	}
	if results[0] != nil {
		requireShopCode(t, results[0], "EQUIPMENT_CHANGED")
		if result.AccessoryLayouts[first.ID] != before.AccessoryLayouts[first.ID] {
			t.Fatal("failed save modified geometry")
		}
	} else if layout := result.AccessoryLayouts[first.ID]; layout.X != .4 || layout.Y != .6 || layout.Size != .3 {
		t.Fatalf("successful save lost geometry: %+v", layout)
	}
}
