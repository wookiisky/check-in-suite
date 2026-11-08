package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 免费背心和已购披风使用同一预设目录，但各自保存颜色。
func TestAppearanceSavesColorsForFreeAndOwnedWearables(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	body, found := character.Get(character.DefaultCharacterKey)
	if !found {
		t.Fatal("missing default body")
	}
	cape, found := character.GetWearable("kaykit-adventurers-knight-back-cape")
	if !found {
		t.Fatal("missing cape")
	}
	product := createProduct(t, f, productFixture{
		Type: shop.TypeWearable, Name: cape.Name, AssetKey: cape.ThumbnailAssetKey, WearableKey: cape.Key, Enabled: true,
	})
	purchase := buyProduct(t, f, product).Purchase
	upperColor, backColor := "ivory", "orange"
	input := shop.SaveAppearanceInput{
		ExpectedVersion: 1, CharacterKey: body.Key, UpperWearableKey: &body.Defaults.Upper,
		BackWearableKey: &purchase.WearableKey, UpperColorKey: &upperColor, BackColorKey: &backColor,
	}
	if _, err := f.Service.SaveAppearance(ctx, f.Principal, input); err != nil {
		t.Fatal(err)
	}
	saved, err := f.Contender.Appearance(ctx, f.Principal)
	if err != nil || saved.UpperColorKey == nil || *saved.UpperColorKey != upperColor || saved.BackColorKey == nil || *saved.BackColorKey != backColor {
		t.Fatalf("saved upper=%v back=%v err=%v", saved.UpperColorKey, saved.BackColorKey, err)
	}
	input.ExpectedVersion = saved.Version
	input.BackWearableKey = nil
	input.UpperColorKey = nil
	_, err = f.Service.SaveAppearance(ctx, f.Principal, input)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	saved, err = f.Contender.Appearance(ctx, f.Principal)
	if err != nil || saved.Version != input.ExpectedVersion || saved.UpperColorKey == nil || *saved.UpperColorKey != upperColor || saved.BackColorKey == nil || *saved.BackColorKey != backColor {
		t.Fatalf("invalid back color changed state: version=%d upper=%v back=%v err=%v", saved.Version, saved.UpperColorKey, saved.BackColorKey, err)
	}
}
