package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 默认外观不写库，首次整套保存生成一个独立版本。
func TestAppearanceDefaultsAndAtomicRestore(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	initial, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || initial.Version != 1 || initial.CharacterKey != "kaykit-medium-v1" || initial.HeadWearableKey != nil || len(initial.Inventory) != 0 || len(initial.Characters) == 0 || len(initial.Wearables) < 8 {
		t.Fatalf("initial=%+v err=%v", initial, err)
	}
	hair := buyProduct(t, f, createProduct(t, f, appearanceProduct("head", "barbarian"))).Purchase
	upper := buyProduct(t, f, createProduct(t, f, appearanceProduct("upper", "barbarian"))).Purchase
	input := shop.SaveAppearanceInput{ExpectedVersion: initial.Version, CharacterKey: initial.CharacterKey, HeadWearableKey: &hair.WearableKey, UpperWearableKey: &upper.WearableKey}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, input)
	if err != nil || saved.Version != 2 || saved.HeadWearableKey == nil || *saved.HeadWearableKey != hair.WearableKey || saved.UpperWearableKey == nil || *saved.UpperWearableKey != upper.WearableKey || len(saved.Inventory) != 2 {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	restored, err := f.Contender.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: initial.CharacterKey})
	if err != nil || restored.Version != 3 || restored.HeadWearableKey != nil || restored.UpperWearableKey != nil || len(restored.Inventory) != 2 {
		t.Fatalf("restored=%+v err=%v", restored, err)
	}
	equipment, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || equipment.Title != nil {
		t.Fatalf("appearance changed title: %+v %v", equipment, err)
	}
}

// 无效槽位不能留下部分外观，也不能通过二维接口装备三维商品。
func TestAppearanceRejectsInvalidSelectionsWithoutPartialSave(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	hair := buyProduct(t, f, createProduct(t, f, appearanceProduct("head", "barbarian"))).Purchase
	old := buyProduct(t, f, createProduct(t, f, productInput("title"))).Purchase
	valid := shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: "kaykit-medium-v1", HeadWearableKey: &hair.WearableKey}
	if _, err := f.Service.SaveAppearance(ctx, f.Principal, valid); err != nil {
		t.Fatal(err)
	}
	invalid := []shop.SaveAppearanceInput{
		{ExpectedVersion: 2, CharacterKey: valid.CharacterKey, HeadWearableKey: &old.ID},
		{ExpectedVersion: 2, CharacterKey: valid.CharacterKey, UpperWearableKey: &hair.WearableKey},
	}
	for _, input := range invalid {
		_, err := f.Service.SaveAppearance(ctx, f.Principal, input)
		requireShopCode(t, err, "INVALID_EQUIPMENT")
	}
	empty := ""
	_, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: valid.CharacterKey, HeadWearableKey: &empty})
	requireShopCode(t, err, "INVALID_REQUEST")
	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: "missing"})
	requireShopCode(t, err, "INVALID_REQUEST")
	missing := "missing"
	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: valid.CharacterKey, HeadWearableKey: &missing})
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	_, err = f.Service.SetTitle(ctx, f.Principal, &hair.ID)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	result, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || result.Version != 2 || result.HeadWearableKey == nil || *result.HeadWearableKey != hair.WearableKey || result.UpperWearableKey != nil {
		t.Fatalf("partial update=%+v %v", result, err)
	}
}

// 购买时复制稳定服装身份，删除或修改报价不能改掉订单和装备资格。
func TestAppearanceUsesPurchasedDefinitionAfterOfferDeletion(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	product := createProduct(t, f, appearanceProduct("shoes", "barbarian"))
	purchase := buyProduct(t, f, product).Purchase
	if purchase.WearableKey != "shoes-barbarian-v1" {
		t.Fatalf("snapshot=%+v", purchase)
	}
	retireHistoricalProduct(t, f, product.ID)
	state, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: "kaykit-medium-v1", ShoesWearableKey: &purchase.WearableKey})
	if err != nil || state.ShoesWearableKey == nil || *state.ShoesWearableKey != purchase.WearableKey {
		t.Fatalf("deleted offer lost ownership: %+v %v", state, err)
	}
}

// 两个真实连接竞争同一外观版本时只允许一个整套保存成功。
func TestAppearanceConcurrentVersionHasSingleWinner(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	hair := buyProduct(t, f, createProduct(t, f, appearanceProduct("head", "barbarian"))).Purchase
	shoes := buyProduct(t, f, createProduct(t, f, appearanceProduct("shoes", "barbarian"))).Purchase
	results := compete(func() error {
		_, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: "kaykit-medium-v1", HeadWearableKey: &hair.WearableKey})
		return err
	}, func() error {
		_, err := f.Contender.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: "kaykit-medium-v1", ShoesWearableKey: &shoes.WearableKey})
		return err
	})
	success := 0
	for _, err := range results {
		if err == nil {
			success++
		} else {
			requireShopCode(t, err, "VERSION_CONFLICT")
		}
	}
	if success != 1 {
		t.Fatalf("results=%v", results)
	}
	state, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || state.Version != 2 || (state.HeadWearableKey == nil) == (state.ShoesWearableKey == nil) {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}

// 数据库提交失败应完整回滚外观，撤销会话后读写均不可继续。
func TestAppearanceCommitFailureAndSessionRevocation(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if _, err := f.DB.Exec(`CREATE TABLE appearance_commit_probe (
        id INTEGER PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER fail_appearance_commit AFTER INSERT ON appearance_state BEGIN
        INSERT INTO appearance_commit_probe(id,product_id) VALUES(1,'missing-product');
    END`); err != nil {
		t.Fatal(err)
	}
	input := shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: "kaykit-medium-v1"}
	if _, err := f.Service.SaveAppearance(ctx, f.Principal, input); err == nil {
		t.Fatal("expected actual SQLite deferred-constraint commit failure")
	}
	state, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || state.Version != 1 {
		t.Fatalf("partial=%+v %v", state, err)
	}
	if err = f.Accounts.Logout(ctx, f.Principal); err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.Appearance(ctx, f.Principal)
	requireShopCode(t, err, "SESSION_REQUIRED")
	_, err = f.Service.SaveAppearance(ctx, f.Principal, input)
	requireShopCode(t, err, "SESSION_REQUIRED")
}

// 穿戴配置由目录补齐，缩略图、模型和无关图片都不能新增报价。
func TestWearableProductRequiresMatchingDefinition(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := appearanceProduct("head", "barbarian")
	wearable, ok := character.GetWearable(input.WearableKey)
	if !ok {
		t.Fatal("missing wearable")
	}
	for _, assetKey := range []string{wearable.ThumbnailAssetKey, wearable.ModelAssetKey, "settings-v1", "unknown"} {
		invalid := input.createInput()
		invalid.AssetKey = assetKey
		_, err := f.Service.CreateProduct(ctx, f.Principal, assetKey, invalid)
		requireShopCode(t, err, "INVALID_REQUEST")
	}
}

// 外观库存必须完整，能装备未进入当前订单页的穿戴。
func TestAppearanceInventoryDoesNotUsePurchasePagination(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	head := buyProduct(t, f, createProduct(t, f, appearanceProduct("head", "barbarian"))).Purchase
	upper := buyProduct(t, f, createProduct(t, f, appearanceProduct("upper", "barbarian"))).Purchase
	page, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: shop.TypeWearable, Limit: 1})
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("page=%+v %v", page, err)
	}
	state, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || len(state.Inventory) != 2 {
		t.Fatalf("inventory count=%d err=%v", len(state.Inventory), err)
	}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{
		ExpectedVersion: state.Version, CharacterKey: state.CharacterKey, HeadWearableKey: &head.WearableKey, UpperWearableKey: &upper.WearableKey,
	})
	if err != nil || saved.HeadWearableKey == nil || *saved.HeadWearableKey != head.WearableKey || saved.UpperWearableKey == nil || *saved.UpperWearableKey != upper.WearableKey {
		t.Fatalf("complete ownership lost: %+v %v", saved, err)
	}
}
