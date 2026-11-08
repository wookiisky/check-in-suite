package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 新形象、头部与背部同其他部位一起原子保存，错误部位不能部分覆盖已保存选择。
func TestAppearanceFaceHeadAndBackAreIndependentOwnedSlots(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	state, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	defaultKeys := make(map[string]bool)
	for _, body := range state.Characters {
		for _, slot := range character.Slots() {
			defaultKeys[body.Defaults.ForSlot(slot)] = true
		}
	}
	ownedKeys := make(map[character.Slot]string)
	for _, slot := range []character.Slot{character.SlotFace, character.SlotHead, character.SlotBack} {
		var candidate character.Wearable
		for _, item := range state.Wearables {
			if item.Slot == slot && !item.Empty && !defaultKeys[item.Key] {
				candidate = item
				break
			}
		}
		if candidate.Key == "" {
			t.Fatalf("no non-default %s wearable", slot)
		}
		product := createProduct(t, f, productFixture{Type: shop.TypeWearable, Name: candidate.Name, AssetKey: candidate.ThumbnailAssetKey, WearableKey: candidate.Key, Enabled: true})
		ownedKeys[slot] = buyProduct(t, f, product).Purchase.WearableKey
	}
	face, head, back := ownedKeys[character.SlotFace], ownedKeys[character.SlotHead], ownedKeys[character.SlotBack]
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: state.CharacterKey, FaceWearableKey: &face, HeadWearableKey: &head, BackWearableKey: &back})
	if err != nil || saved.FaceWearableKey == nil || saved.HeadWearableKey == nil || saved.BackWearableKey == nil || *saved.FaceWearableKey != face || *saved.HeadWearableKey != head || *saved.BackWearableKey != back {
		t.Fatalf("six-slot save=%+v err=%v", saved, err)
	}
	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: state.CharacterKey, FaceWearableKey: &back, HeadWearableKey: &head, BackWearableKey: &back})
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	after, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || after.Version != 2 || after.FaceWearableKey == nil || *after.FaceWearableKey != face {
		t.Fatalf("invalid save partially applied: %+v %v", after, err)
	}
	cleared, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: state.CharacterKey})
	if err != nil || cleared.Version != 3 || cleared.FaceWearableKey != nil || cleared.HeadWearableKey != nil || cleared.BackWearableKey != nil {
		t.Fatalf("restore=%+v err=%v", cleared, err)
	}
}

// 骷髅默认形象属于已购身体，不能利用免费来源绕过购买，也不能借身体订单装进形象槽。
func TestAppearanceOwnedBodyDefaultsRequireBodyEntitlement(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	var skeleton character.Definition
	for _, body := range character.Definitions() {
		if body.Key != character.DefaultCharacterKey {
			skeleton = body
			break
		}
	}
	if skeleton.Key == "" {
		t.Fatal("missing purchasable skeleton")
	}
	input := shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: character.DefaultCharacterKey, FaceWearableKey: &skeleton.Defaults.Face}
	_, err := f.Service.SaveAppearance(ctx, f.Principal, input)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	purchase := buyProduct(t, f, createProduct(t, f, catalogCharacterProduct(t))).Purchase
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, input)
	if err != nil || saved.FaceWearableKey == nil || *saved.FaceWearableKey != skeleton.Defaults.Face || len(saved.Inventory) != 0 {
		t.Fatalf("owned default: %+v %v", saved, err)
	}
	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: skeleton.Key, FaceWearableKey: &purchase.ID})
	requireShopCode(t, err, "INVALID_EQUIPMENT")
}

// 六槽筛选同时适用于商品和订单；退役的hair名称不再被解释为头部。
func TestAppearanceCatalogFiltersAcceptSixSlots(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	for _, slot := range character.Slots() {
		if _, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Slot: string(slot), Limit: 20}); err != nil {
			t.Fatalf("product filter %s: %v", slot, err)
		}
		if _, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Slot: string(slot)}); err != nil {
			t.Fatalf("purchase filter %s: %v", slot, err)
		}
	}
	_, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Slot: "hair", Limit: 20})
	requireShopCode(t, err, "INVALID_REQUEST")
	_, err = f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Slot: "hair"})
	requireShopCode(t, err, "INVALID_REQUEST")
}

// 空件和默认件可以指向同一个定义，但保存时保留主动选择。
func TestAppearancePreservesExplicitEmptyWearable(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	body, ok := character.Get(character.DefaultCharacterKey)
	if !ok {
		t.Fatal("missing default character")
	}
	emptyHead := body.Defaults.Head
	empty, ok := character.GetWearable(emptyHead)
	if !ok || !empty.Empty {
		t.Fatalf("expected empty head, got %+v", empty)
	}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{
		ExpectedVersion: 1, CharacterKey: body.Key, HeadWearableKey: &emptyHead,
	})
	if err != nil || saved.HeadWearableKey == nil || *saved.HeadWearableKey != emptyHead {
		t.Fatalf("empty wearable: %+v %v", saved, err)
	}
	restored, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{
		ExpectedVersion: saved.Version, CharacterKey: body.Key,
	})
	if err != nil || restored.HeadWearableKey != nil {
		t.Fatalf("default wearable: %+v %v", restored, err)
	}
}
