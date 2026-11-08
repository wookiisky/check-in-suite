package shop_test

import (
	"context"
	"errors"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 新角色测试使用正式导入目录，确保商品不是只有字段而没有实际资源。
func catalogCharacterProduct(t *testing.T) productFixture {
	t.Helper()
	for _, item := range character.Definitions() {
		if item.Key != character.DefaultCharacterKey {
			return productFixture{Type: shop.TypeCharacter, CharacterKey: item.Key, Name: item.Name, AssetKey: item.ThumbnailAssetKey, Enabled: true}
		}
	}
	t.Fatal("正式目录缺少可购买的新角色")
	return productFixture{}
}

// 完整角色所有权来自成交快照，删除报价后依然可换装且未购买时不能保存。
func TestCharacterPurchaseOwnershipAndSharedWardrobe(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := catalogCharacterProduct(t)
	product := createProduct(t, f, input)
	_, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: input.CharacterKey})
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	purchase := buyProduct(t, f, product).Purchase
	if purchase.CharacterKey != input.CharacterKey {
		t.Fatalf("snapshot=%+v", purchase)
	}
	retireHistoricalProduct(t, f, product.ID)
	hair := buyProduct(t, f, createProduct(t, f, appearanceProduct("head", "barbarian"))).Purchase
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: input.CharacterKey, HeadPurchaseID: &hair.ID})
	if err != nil || saved.CharacterKey != input.CharacterKey || saved.HeadPurchaseID == nil || *saved.HeadPurchaseID != hair.ID {
		t.Fatalf("shared outfit=%+v err=%v", saved, err)
	}
	if len(saved.CharacterInventory) != 1 || saved.CharacterInventory[0].CharacterKey != input.CharacterKey {
		t.Fatalf("character inventory=%+v", saved.CharacterInventory)
	}
	// 基础身体订单只解锁身体，不能充当任一独立穿戴商品的订单。
	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: saved.Version, CharacterKey: character.DefaultCharacterKey, HeadPurchaseID: &purchase.ID})
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	if len(saved.Inventory) != 1 {
		t.Fatalf("body order expanded into clothing: %+v", saved.Inventory)
	}

	_, err = f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: character.DefaultCharacterKey})
	requireShopCode(t, err, "VERSION_CONFLICT")
}

// 相同角色的不同报价共享所有权，不能用另一个商品身份重复购买。
func TestCharacterDifferentOffersCannotDuplicateOwnership(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := catalogCharacterProduct(t)
	first, second := createProduct(t, f, input), createProduct(t, f, input)
	buyProduct(t, f, first)
	balance := readBalance(t, f)
	_, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: second.ID, ExpectedProductVersion: second.Version, ExpectedWalletVersion: balance.Version})
	requireShopCode(t, err, "ALREADY_OWNED")
	products, err := f.Service.ListProducts(ctx, f.Principal, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range products.Items {
		if !item.Owned || item.OwnedCount != 1 {
			t.Fatalf("offer ownership=%+v", item)
		}
	}
}

// 真实独立连接同时购买同一角色时，只能提交一笔订单和扣款。
func TestCharacterConcurrentOffersHaveSinglePurchase(t *testing.T) {
	f := newShopFixture(t)
	input := catalogCharacterProduct(t)
	first, second := createProduct(t, f, input), createProduct(t, f, input)
	balance := readBalance(t, f)
	results := compete(func() error {
		_, err := f.Service.Buy(context.Background(), f.Principal, core.ID(), shop.BuyInput{ProductID: first.ID, ExpectedProductVersion: first.Version, ExpectedWalletVersion: balance.Version})
		return err
	}, func() error {
		_, err := f.Contender.Buy(context.Background(), f.Principal, core.ID(), shop.BuyInput{ProductID: second.ID, ExpectedProductVersion: second.Version, ExpectedWalletVersion: balance.Version})
		return err
	})
	successes := 0
	for _, err := range results {
		if err == nil {
			successes++
		} else {
			var failure *core.Error
			if !errors.As(err, &failure) || (failure.Code != "WALLET_CHANGED" && failure.Code != "ALREADY_OWNED") {
				t.Fatalf("unexpected concurrent error: %v", err)
			}
		}
	}
	var orders, entries int
	if err := f.DB.QueryRow("SELECT count(*) FROM purchases WHERE type_snapshot='character'").Scan(&orders); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE event_type='purchase_debit'").Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if successes != 1 || orders != 1 || entries != 1 {
		t.Fatalf("results=%v orders=%d entries=%d", results, orders, entries)
	}
}

// 基础人物和原始模型不可出售，商品从当前人物缩略图取得角色身份。
func TestCharacterProductBindsSaleableBody(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	defaultBody, ok := character.Get(character.DefaultCharacterKey)
	if !ok {
		t.Fatal("missing default character")
	}
	input := catalogCharacterProduct(t)
	for _, key := range []string{defaultBody.ThumbnailAssetKey, defaultBody.ModelAssetKey, "missing"} {
		invalid := input.createInput()
		invalid.AssetKey = key
		_, err := f.Service.CreateProduct(ctx, f.Principal, core.ID(), invalid)
		requireShopCode(t, err, "INVALID_REQUEST")
	}
	product := createProduct(t, f, input)
	if product.CharacterKey != input.CharacterKey || product.AssetKey != input.AssetKey {
		t.Fatalf("body offer=%+v", product)
	}
}

// 插入角色订单失败不能留下扣款、权益或幂等成功回执；原请求可在故障修复后恢复。
func TestCharacterPurchaseFailureRollsBackAndRetries(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := catalogCharacterProduct(t)
	input.CoinPrice = 95
	product := createProduct(t, f, input)
	balance := creditFixture(t, f, 100, 0)
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_character_purchase BEFORE INSERT ON purchases WHEN NEW.type_snapshot='character' BEGIN SELECT RAISE(ABORT,'character purchase failure'); END;`); err != nil {
		t.Fatal(err)
	}
	command := shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: balance.Version}
	key := core.ID()
	if _, err := f.Service.Buy(ctx, f.Principal, key, command); err == nil {
		t.Fatal("failed order was reported successful")
	}
	after := readBalance(t, f)
	if after != balance {
		t.Fatalf("failed order changed wallet: %+v -> %+v", balance, after)
	}
	state, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || len(state.CharacterInventory) != 0 || len(state.Inventory) != 0 {
		t.Fatalf("partial rights=%+v err=%v", state, err)
	}
	if _, err := f.DB.Exec("DROP TRIGGER reject_character_purchase"); err != nil {
		t.Fatal(err)
	}
	result, err := f.Service.Buy(ctx, f.Principal, key, command)
	if err != nil || result.Wallet.Coins != 5 {
		t.Fatalf("retry=%+v err=%v", result, err)
	}
	replay, err := f.Service.Buy(ctx, f.Principal, key, command)
	if err != nil || replay.Purchase.ID != result.Purchase.ID || replay.Wallet != result.Wallet {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
}

// 新角色报价只补新增条目，重试不覆盖管理价格、库存、下架与软删除状态。
func TestCharacterSeedRetainsManagedOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedCharacterProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	offers, err := f.Service.ListProducts(ctx, f.Principal, true)
	if err != nil || len(offers.Items) != len(character.Definitions())-1 || len(offers.Items) == 0 {
		t.Fatalf("offers=%+v err=%v", offers, err)
	}
	managed := offers.Items[0]
	if managed.CoinPrice != 95 || managed.DiamondPrice != 0 {
		t.Fatalf("initial prices=%+v", managed)
	}
	if _, err := f.DB.Exec("UPDATE products SET coin_price=77,stock=2,enabled=0,deleted_at=3,version=5 WHERE id=?", managed.ID); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCharacterProducts(ctx, f.Other, f.Now.UnixMilli()+1); err != nil {
		t.Fatal(err)
	}
	var price, stock, enabled, deleted, version int
	if err := f.DB.QueryRow("SELECT coin_price,stock,enabled,deleted_at,version FROM products WHERE id=?", managed.ID).Scan(&price, &stock, &enabled, &deleted, &version); err != nil {
		t.Fatal(err)
	}
	if price != 77 || stock != 2 || enabled != 0 || deleted != 3 || version != 5 {
		t.Fatalf("managed changed: %d %d %d %d %d", price, stock, enabled, deleted, version)
	}
}

// 初始免费人物的衣服必须能给新人物穿，并真实保存；免费选择不能伪造付费权益。
func TestCharacterCanWearInitialFreeOutfit(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	role := catalogCharacterProduct(t)
	roleOrder := buyProduct(t, f, createProduct(t, f, role)).Purchase
	defaults, _ := character.Get(character.DefaultCharacterKey)
	command := shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: role.CharacterKey, HeadFreeWearableKey: &defaults.Defaults.Head, UpperFreeWearableKey: &defaults.Defaults.Upper, LowerFreeWearableKey: &defaults.Defaults.Lower, ShoesFreeWearableKey: &defaults.Defaults.Shoes}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, command)
	if err != nil || saved.Version != 2 || saved.HeadFreeWearableKey == nil || *saved.HeadFreeWearableKey != defaults.Defaults.Head || saved.HeadPurchaseID != nil || saved.UpperPurchaseID != nil {
		t.Fatalf("free outfit=%+v err=%v", saved, err)
	}
	read, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || read.UpperFreeWearableKey == nil || *read.UpperFreeWearableKey != defaults.Defaults.Upper || read.LowerFreeWearableKey == nil || *read.LowerFreeWearableKey != defaults.Defaults.Lower || read.ShoesFreeWearableKey == nil || *read.ShoesFreeWearableKey != defaults.Defaults.Shoes {
		t.Fatalf("free outfit not persisted: %+v err=%v", read, err)
	}
	_, err = f.Contender.SaveAppearance(ctx, f.Principal, command)
	requireShopCode(t, err, "VERSION_CONFLICT")
	invalid := command
	invalid.ExpectedVersion = 2
	invalid.HeadPurchaseID = &roleOrder.ID
	_, err = f.Service.SaveAppearance(ctx, f.Principal, invalid)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	paid := role.CharacterKey
	for _, candidate := range character.Definitions() {
		if candidate.Key != character.DefaultCharacterKey && candidate.Key != role.CharacterKey && candidate.Defaults.Head != defaults.Defaults.Head {
			paid = candidate.Defaults.Head
			break
		}
	}
	invalid = command
	invalid.ExpectedVersion = 2
	invalid.HeadFreeWearableKey = &paid
	_, err = f.Service.SaveAppearance(ctx, f.Principal, invalid)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	invalid = command
	invalid.ExpectedVersion = 2
	invalid.HeadFreeWearableKey = &defaults.Defaults.Upper
	_, err = f.Service.SaveAppearance(ctx, f.Principal, invalid)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	invalid = command
	invalid.ExpectedVersion = 2
	invalid.ShoesFreeWearableKey = &defaults.Defaults.Upper
	_, err = f.Service.SaveAppearance(ctx, f.Principal, invalid)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	invalid = command
	invalid.ExpectedVersion = 2
	empty := ""
	invalid.HeadFreeWearableKey = &empty
	_, err = f.Service.SaveAppearance(ctx, f.Principal, invalid)
	requireShopCode(t, err, "INVALID_REQUEST")
	after, err := f.Service.Appearance(ctx, f.Principal)
	if err != nil || after.Version != 2 || after.HeadFreeWearableKey == nil || *after.HeadFreeWearableKey != defaults.Defaults.Head {
		t.Fatalf("invalid selection partially committed: %+v err=%v", after, err)
	}
	var count int
	if err := f.DB.QueryRow("SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 1 {
		t.Fatalf("free outfit manufactured order count=%d err=%v", count, err)
	}
	restored, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 2, CharacterKey: role.CharacterKey})
	if err != nil || restored.Version != 3 || restored.HeadFreeWearableKey != nil || restored.UpperFreeWearableKey != nil || restored.LowerFreeWearableKey != nil || restored.ShoesFreeWearableKey != nil {
		t.Fatalf("default role outfit not restored: %+v err=%v", restored, err)
	}
}
