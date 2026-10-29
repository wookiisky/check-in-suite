package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestWearableSlotsReplaceAndPersist verifies ownership and isolation at the real database boundary.
func TestWearableSlotsReplaceAndPersist(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	initial, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || initial.BaseAvatarKey != assets.DefaultAvatar || initial.Wearables.Hair != nil {
		t.Fatalf("initial equipment: %+v %v", initial, err)
	}
	for _, sample := range []struct{ slot, key string }{
		{"hair", "hair-curly-v1"}, {"top", "wearable-top-explorer-v1"},
		{"bottom", "wearable-bottom-denim-v1"}, {"shoes", "wearable-shoes-boots-v1"},
	} {
		t.Run(sample.slot, func(t *testing.T) {
			input := productInput("accessory")
			input.AssetKey = sample.key
			product := createProduct(t, f, input)
			bought := buyProduct(t, f, product).Purchase
			if string(bought.WearableSlot) != sample.slot || string(product.WearableSlot) != sample.slot {
				t.Fatalf("missing wearable metadata: %+v %+v", product, bought)
			}
			for i := 0; i < 2; i++ {
				if _, err = f.Service.SetSlot(ctx, f.Principal, sample.slot, &bought.ID); err != nil {
					t.Fatal(err)
				}
			}
			_, err = f.Service.SetAccessory(ctx, f.Principal, bought.ID, true)
			requireShopCode(t, err, "INVALID_EQUIPMENT")
			_, err = f.Service.SetAccessoryLayout(ctx, f.Principal, bought.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .2})
			requireShopCode(t, err, "INVALID_EQUIPMENT")
			// An offer may disappear without taking the already purchased garment away.
			if err = f.Service.DeleteProduct(ctx, f.Principal, product.ID, product.Version); err != nil {
				t.Fatal(err)
			}
			if _, err = f.Service.SetSlot(ctx, f.Principal, sample.slot, &bought.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
	persisted, err := f.Contender.Equipment(ctx, f.Principal)
	if err != nil || persisted.Wearables.Hair == nil || persisted.Wearables.Top == nil || persisted.Wearables.Bottom == nil || persisted.Wearables.Shoes == nil {
		t.Fatalf("persisted equipment: %+v %v", persisted, err)
	}
	if len(persisted.Accessories) != 0 || len(persisted.AccessoryLayouts) != 0 {
		t.Fatalf("wearables consumed accessory layouts: %+v", persisted)
	}
	nextInput := productInput("accessory")
	nextInput.AssetKey = "hair-braids-v1"
	next := buyProduct(t, f, createProduct(t, f, nextInput)).Purchase
	updated, err := f.Service.SetSlot(ctx, f.Principal, "hair", &next.ID)
	if err != nil || updated.Wearables.Hair.ID != next.ID || updated.Wearables.Top.ID != persisted.Wearables.Top.ID {
		t.Fatalf("replace: %+v %v", updated, err)
	}
	cleared, err := f.Service.SetSlot(ctx, f.Principal, "hair", nil)
	if err != nil || cleared.Wearables.Hair != nil || cleared.Wearables.Top == nil {
		t.Fatalf("clear: %+v %v", cleared, err)
	}
	if next.BackAssetKey == "" {
		t.Fatal("long hairstyle lost back layer metadata")
	}
}

// TestWearableSlotsRejectWrongOwnershipAndRole keeps failed writes from changing saved equipment.
func TestWearableSlotsRejectWrongOwnershipAndRole(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := productInput("accessory")
	input.AssetKey = "hair-short-v1"
	hair := buyProduct(t, f, createProduct(t, f, input)).Purchase
	_, err := f.Service.SetSlot(ctx, f.Principal, "top", &hair.ID)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	ordinary := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	_, err = f.Service.SetSlot(ctx, f.Principal, "hair", &ordinary.ID)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	missing := core.ID()
	_, err = f.Service.SetSlot(ctx, f.Principal, "hair", &missing)
	requireShopCode(t, err, "NOT_FOUND")
	_, err = f.Service.SetSlot(ctx, f.Principal, "cape", &hair.ID)
	requireShopCode(t, err, "INVALID_REQUEST")
	_, err = f.Service.SetSlot(ctx, account.Principal{}, "hair", &hair.ID)
	requireShopCode(t, err, "SESSION_REQUIRED")
	state, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || state.Wearables.Hair != nil || state.Wearables.Top != nil {
		t.Fatalf("failed writes changed slots: %+v %v", state, err)
	}
}

// TestFreeBaseAvatarSelection preserves garments while leaving a purchased animal form.
func TestFreeBaseAvatarSelection(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := productInput("accessory")
	input.AssetKey = "hair-curly-v1"
	hair := buyProduct(t, f, createProduct(t, f, input)).Purchase
	if _, err := f.Service.SetSlot(ctx, f.Principal, "hair", &hair.ID); err != nil {
		t.Fatal(err)
	}
	bunny := buyProduct(t, f, createProduct(t, f, productInput("avatar"))).Purchase
	if _, err := f.Service.SetSlot(ctx, f.Principal, "avatar", &bunny.ID); err != nil {
		t.Fatal(err)
	}
	state, err := f.Service.SetBaseAvatar(ctx, f.Principal, "avatar-girl-v2")
	if err != nil || state.Avatar != nil || state.BaseAvatarKey != "avatar-girl-v2" || state.Wearables.Hair == nil || state.Wearables.Hair.ID != hair.ID {
		t.Fatalf("select base: %+v %v", state, err)
	}
	for _, key := range []string{"bunny-v1", "hair-short-v1", "missing-v1"} {
		_, err = f.Service.SetBaseAvatar(ctx, f.Principal, key)
		requireShopCode(t, err, "INVALID_REQUEST")
	}
	_, err = f.Service.SetBaseAvatar(ctx, account.Principal{}, "avatar-boy-v2")
	requireShopCode(t, err, "SESSION_REQUIRED")
	for _, sample := range []struct{ kind, key string }{{"avatar", "avatar-boy-v2"}, {"accessory", "default-top-v1"}} {
		input := productInput(sample.kind)
		input.AssetKey = sample.key
		_, err = f.Service.CreateProduct(ctx, f.Principal, core.ID(), input)
		requireShopCode(t, err, "INVALID_REQUEST")
	}
}

// TestConcurrentWearableSlotsKeepIndependentSelections uses two real SQLite connections.
func TestConcurrentWearableSlotsKeepIndependentSelections(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	hairInput := productInput("accessory")
	hairInput.AssetKey = "hair-curly-v1"
	topInput := productInput("accessory")
	topInput.AssetKey = "wearable-top-explorer-v1"
	hair := buyProduct(t, f, createProduct(t, f, hairInput)).Purchase
	top := buyProduct(t, f, createProduct(t, f, topInput)).Purchase
	results := compete(func() error { _, err := f.Service.SetSlot(ctx, f.Principal, "hair", &hair.ID); return err }, func() error { _, err := f.Contender.SetSlot(ctx, f.Principal, "top", &top.ID); return err })
	if results[0] != nil || results[1] != nil {
		t.Fatal(results)
	}
	saved, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || saved.Wearables.Hair == nil || saved.Wearables.Top == nil || saved.Wearables.Hair.ID != hair.ID || saved.Wearables.Top.ID != top.ID {
		t.Fatalf("concurrent selections were lost: %+v %v", saved, err)
	}
}

// TestWearablesDoNotConsumeAccessoryCapacity checks the real ten-decoration limit with a full outfit.
func TestWearablesDoNotConsumeAccessoryCapacity(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	for i := 0; i < shop.AccessoryLimit; i++ {
		accessory := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
		if _, err := f.Service.SetAccessory(ctx, f.Principal, accessory.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	input := productInput("accessory")
	input.AssetKey = "hair-curly-v1"
	hair := buyProduct(t, f, createProduct(t, f, input)).Purchase
	equipment, err := f.Service.SetSlot(ctx, f.Principal, "hair", &hair.ID)
	if err != nil || equipment.Wearables.Hair == nil || len(equipment.Accessories) != shop.AccessoryLimit {
		t.Fatalf("fixed wearable consumed decoration capacity: %+v %v", equipment, err)
	}
}
