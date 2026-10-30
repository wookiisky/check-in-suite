package shop_test

import (
	"context"
	"math"
	"reflect"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestAccessoryLayoutPersistsBehindAvatarAndSurvivesUnequip exercises the actual stored outfit.
func TestAccessoryLayoutPersistsBehindAvatarAndSurvivesUnequip(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	first := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	second := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	for _, item := range []shop.Purchase{first, second} {
		if _, err := f.Service.SetAccessory(ctx, f.Principal, item.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	anchor := "avatar"
	input := shop.AccessoryLayoutInput{X: .4, Y: .6, Size: .3, Rotation: 45, BeforeID: &anchor}
	result, err := f.Service.SetAccessoryLayout(ctx, f.Principal, second.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if got := result.AccessoryLayouts[second.ID]; got.X != .4 || got.Y != .6 || got.Size != .3 || got.Rotation != 45 || got.Layer != -1 {
		t.Fatalf("saved layout=%+v", got)
	}
	replayed, err := f.Contender.SetAccessoryLayout(ctx, f.Principal, second.ID, input)
	if err != nil || !reflect.DeepEqual(result, replayed) {
		t.Fatalf("retry changed state: %+v %v", replayed, err)
	}
	if _, err := f.Service.SetAccessory(ctx, f.Principal, second.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.SetAccessory(ctx, f.Principal, second.ID, true); err != nil {
		t.Fatal(err)
	}
	restored, err := f.Contender.Equipment(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	layout := restored.AccessoryLayouts[second.ID]
	if layout.X != .4 || layout.Y != .6 || layout.Size != .3 || layout.Rotation != 45 || layout.Layer <= restored.AccessoryLayouts[first.ID].Layer {
		t.Fatalf("reequip did not retain geometry on top: %+v", restored)
	}
}

// TestAccessoryLayoutRejectsInvalidState leaves the previously saved outfit intact.
func TestAccessoryLayoutRejectsInvalidState(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	item := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	other := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	if _, err := f.Service.SetAccessory(ctx, f.Principal, item.ID, true); err != nil {
		t.Fatal(err)
	}
	before, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string                    // Identifies the invalid protocol or ownership boundary.
		id    string                    // Accessory being changed.
		input shop.AccessoryLayoutInput // Attempted absolute state.
		code  string                    // Expected stable error code.
	}{
		{"outside", item.ID, shop.AccessoryLayoutInput{X: 0, Y: .5, Size: .3}, "INVALID_REQUEST"},
		{"too small", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .01}, "INVALID_REQUEST"},
		{"not finite", item.ID, shop.AccessoryLayoutInput{X: math.NaN(), Y: .5, Size: .3}, "INVALID_REQUEST"},
		{"negative angle", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, Rotation: -1}, "INVALID_REQUEST"},
		{"full turn", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, Rotation: 360}, "INVALID_REQUEST"},
		{"nan angle", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, Rotation: math.NaN()}, "INVALID_REQUEST"},
		{"infinite angle", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, Rotation: math.Inf(1)}, "INVALID_REQUEST"},
		{"rotated outside", item.ID, shop.AccessoryLayoutInput{X: .15, Y: .5, Size: .3, Rotation: 45}, "INVALID_REQUEST"},
		{"rotated too large", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .8, Rotation: 45}, "INVALID_REQUEST"},
		{"missing target", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, BeforeID: &other.ID}, "EQUIPMENT_CHANGED"},
		{"self target", item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3, BeforeID: &item.ID}, "INVALID_REQUEST"},
		{"not equipped", other.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: .3}, "EQUIPMENT_CHANGED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.Service.SetAccessoryLayout(ctx, f.Principal, tc.id, tc.input)
			requireShopCode(t, err, tc.code)
			after, err := f.Contender.Equipment(ctx, f.Principal)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("invalid save changed outfit: %+v %v", after, err)
			}
		})
	}
	for _, angle := range []float64{0, 90, 180, 270} {
		if _, err := f.Service.SetAccessoryLayout(ctx, f.Principal, item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: 1, Rotation: angle}); err != nil {
			t.Fatalf("full canvas at %v degrees: %v", angle, err)
		}
	}
	if _, err := f.Service.SetAccessoryLayout(ctx, f.Principal, item.ID, shop.AccessoryLayoutInput{X: .5, Y: .5, Size: 1 / math.Sqrt2, Rotation: 45}); err != nil {
		t.Fatalf("rotated exact edge contact: %v", err)
	}
}

// TestConcurrentAccessoryLayoutsPreserveBothGeometries uses separate SQLite connections.
func TestConcurrentAccessoryLayoutsPreserveBothGeometries(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	first := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	second := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
	for _, item := range []shop.Purchase{first, second} {
		if _, err := f.Service.SetAccessory(ctx, f.Principal, item.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	anchor := "avatar"
	results := compete(func() error {
		_, err := f.Service.SetAccessoryLayout(ctx, f.Principal, first.ID, shop.AccessoryLayoutInput{X: .2, Y: .3, Size: .2, Rotation: 30, BeforeID: &anchor})
		return err
	}, func() error {
		_, err := f.Contender.SetAccessoryLayout(ctx, f.Principal, second.ID, shop.AccessoryLayoutInput{X: .7, Y: .8, Size: .2, Rotation: 315})
		return err
	})
	if results[0] != nil || results[1] != nil {
		t.Fatal(results)
	}
	result, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	a, b := result.AccessoryLayouts[first.ID], result.AccessoryLayouts[second.ID]
	if a.X != .2 || a.Y != .3 || a.Rotation != 30 || a.Layer >= 0 || b.X != .7 || b.Y != .8 || b.Rotation != 315 || b.Layer <= 0 {
		t.Fatalf("concurrent layouts=%+v", result.AccessoryLayouts)
	}
}
