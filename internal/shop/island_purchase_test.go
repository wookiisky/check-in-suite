package shop_test

import (
	"context"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"testing"
)

// 重试保留同一件所有权，重复购买生成独立可摆放实例。
func TestIslandRepeatPurchaseAndLayout(t *testing.T) {
	f := newShopFixture(t)
	balance := creditFixture(t, f, 100, 0)
	input := shop.ProductInput{Type: "island", Name: "测试树", AssetKey: "island-tree-v1", CoinPrice: 10, Enabled: true}
	product := createProduct(t, f, input)
	command := shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: balance.Version}
	key := core.ID()
	first, err := f.Service.Buy(context.Background(), f.Principal, key, command)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := f.Service.Buy(context.Background(), f.Principal, key, command)
	if err != nil || replay.Purchase.ID != first.Purchase.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	command.ExpectedWalletVersion = first.Wallet.Version
	second, err := f.Service.Buy(context.Background(), f.Principal, core.ID(), command)
	if err != nil {
		t.Fatal(err)
	}
	if second.Purchase.ID == first.Purchase.ID || second.Wallet.Coins != 80 {
		t.Fatalf("purchase: %+v", second)
	}
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	state.Placements = append(state.Placements, island.Placement{ID: first.Purchase.ID, ItemKey: "tree", X: 5, Y: 5, Zone: "outdoor"}, island.Placement{ID: second.Purchase.ID, ItemKey: "tree", X: 6, Y: 5, Zone: "outdoor"})
	saved, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != state.Version+1 {
		t.Fatal("version did not advance")
	}
	_, err = service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	requireShopCode(t, err, "VERSION_CONFLICT")
	saved.Placements = append(saved.Placements, island.Placement{ID: "not-owned", ItemKey: "tree", X: 6, Y: 6, Zone: "outdoor"})
	_, err = service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: saved.Version, Placements: saved.Placements})
	requireShopCode(t, err, "INVALID_REQUEST")
}

// 相同物品的不同出售入口不能绕过唯一所有权。
func TestIslandUniqueIdentityAcrossProducts(t *testing.T) {
	f := newShopFixture(t)
	balance := creditFixture(t, f, 100, 0)
	input := shop.ProductInput{Type: "island", Name: "房屋", AssetKey: "island-cottage-v1", Enabled: true}
	one := createProduct(t, f, input)
	two := createProduct(t, f, input)
	first, err := f.Service.Buy(context.Background(), f.Principal, core.ID(), shop.BuyInput{ProductID: one.ID, ExpectedProductVersion: one.Version, ExpectedWalletVersion: balance.Version})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.Buy(context.Background(), f.Principal, core.ID(), shop.BuyInput{ProductID: two.ID, ExpectedProductVersion: two.Version, ExpectedWalletVersion: first.Wallet.Version})
	requireShopCode(t, err, "ALREADY_OWNED")
}

// 双用途物品仅扣一次款，画像卸下和商品下架不会收回岛上实例。
func TestIslandDualUseSurvivesUnlisting(t *testing.T) {
	f := newShopFixture(t)
	creditFixture(t, f, 100, 0)
	input := productInput("accessory")
	input.AssetKey = "accessory-book-v1"
	product := createProduct(t, f, input)
	purchase := buyProduct(t, f, product).Purchase
	if _, err := f.Service.SetAccessory(context.Background(), f.Principal, purchase.ID, true); err != nil {
		t.Fatal(err)
	}
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	state.Placements = append(state.Placements, island.Placement{ID: purchase.ID, ItemKey: "book", X: 1, Y: 1, Zone: "indoor"})
	saved, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Service.DeleteProduct(context.Background(), f.Principal, product.ID, product.Version); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Service.SetAccessory(context.Background(), f.Principal, purchase.ID, false); err != nil {
		t.Fatal(err)
	}
	restored, err := service.Read(context.Background(), f.Principal)
	if err != nil || len(restored.Placements) != len(saved.Placements) {
		t.Fatalf("restored %+v %v", restored, err)
	}
	found := false
	for _, item := range restored.Inventory {
		found = found || item.ID == purchase.ID && item.ItemKey == "book"
	}
	if !found {
		t.Fatal("ownership lost")
	}
}

// 最后一件库存与布局版本冲突使用独立SQLite连接验证。
func TestIslandConcurrentStockAndLayout(t *testing.T) {
	f := newShopFixture(t)
	balance := creditFixture(t, f, 100, 0)
	stock := int64(1)
	product := createProduct(t, f, shop.ProductInput{Type: "island", Name: "树", AssetKey: "island-tree-v1", CoinPrice: 10, Stock: &stock, Enabled: true})
	command := shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: balance.Version}
	results := compete(func() error {
		_, err := f.Service.Buy(context.Background(), f.Principal, "tree-race-one", command)
		return err
	}, func() error {
		_, err := f.Contender.Buy(context.Background(), f.Principal, "tree-race-two", command)
		return err
	})
	requireOneSuccess(t, results)
	if balance = readBalance(t, f); balance.Coins != 90 {
		t.Fatalf("balance %+v", balance)
	}
	first, second := island.New(f.DB, f.Accounts.Now), island.New(f.Other, f.Accounts.Now)
	state, err := first.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	save := island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements}
	results = compete(func() error { _, err := first.Save(context.Background(), f.Principal, save); return err }, func() error { _, err := second.Save(context.Background(), f.Principal, save); return err })
	requireOneSuccess(t, results)
	for _, err := range results {
		if err != nil {
			requireShopCode(t, err, "VERSION_CONFLICT")
		}
	}
}

// 摆放错误不会提交半份布局或提高版本。
func TestIslandPlacementValidation(t *testing.T) {
	f := newShopFixture(t)
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func([]island.Placement) []island.Placement{
		"duplicate":                     func(p []island.Placement) []island.Placement { p[2] = p[0]; return p },
		"wrong identity":                func(p []island.Placement) []island.Placement { p[0].ItemKey = "cottage"; return p },
		"indoor bound":                  func(p []island.Placement) []island.Placement { p[1].X = 2; return p },
		"outdoor bound":                 func(p []island.Placement) []island.Placement { p[0].X = 8; return p },
		"missing home":                  func(p []island.Placement) []island.Placement { return p[1:] },
		"door outside south":            func(p []island.Placement) []island.Placement { p[0].Y = 6.5; return p },
		"door outside west":             func(p []island.Placement) []island.Placement { p[0].Rotation = 90; p[0].X = -6.5; return p },
		"door outside north":            func(p []island.Placement) []island.Placement { p[0].Rotation = 180; p[0].Y = -6.5; return p },
		"door outside east":             func(p []island.Placement) []island.Placement { p[0].Rotation = 270; p[0].X = 6.5; return p },
		"unsupported house orientation": func(p []island.Placement) []island.Placement { p[0].Rotation = 90; return p },
		"bad rotation":                  func(p []island.Placement) []island.Placement { p[0].Rotation = 13; return p },
		"door blocked": func(p []island.Placement) []island.Placement {
			house, _ := island.Find(p[0].ItemKey)
			p[2].X = p[0].X
			p[2].Y = p[0].Y + house.Depth/2 + 0.6
			return p
		},
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			draft := append([]island.Placement{}, state.Placements...)
			_, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: modify(draft)})
			requireShopCode(t, err, "INVALID_REQUEST")
		})
	}
	restored, err := service.Read(context.Background(), f.Principal)
	if err != nil || restored.Version != state.Version {
		t.Fatalf("state %+v %v", restored, err)
	}
}

// 岛屿成交类型不变，新增画像能力使同一订单可用作画像饰品。
func TestIslandPurchaseCanUsePortraitCapability(t *testing.T) {
	f := newShopFixture(t)
	product := createProduct(t, f, shop.ProductInput{Type: "island", Name: "树", AssetKey: "island-tree-v1", Enabled: true})
	purchase := buyProduct(t, f, product).Purchase
	if purchase.TypeSnapshot != "island" || purchase.PortraitType != "accessory" || purchase.PortraitAssetKey != "accessory-tree-v1" {
		t.Fatalf("capabilities %+v", purchase)
	}
	if _, err := f.Service.SetAccessory(context.Background(), f.Principal, purchase.ID, true); err != nil {
		t.Fatal(err)
	}
	equipment, err := f.Service.Equipment(context.Background(), f.Principal)
	if err != nil || len(equipment.Accessories) != 1 || equipment.Accessories[0].PortraitAssetKey != "accessory-tree-v1" {
		t.Fatalf("equipment %+v %v", equipment, err)
	}
	list, err := f.Service.ListPurchases(context.Background(), f.Principal, shop.PurchaseQuery{Type: "accessory", Status: "owned"})
	if err != nil || len(list.Items) != 1 || list.Items[0].ID != purchase.ID {
		t.Fatalf("filtered %+v %v", list, err)
	}
	state, err := island.New(f.DB, f.Accounts.Now).Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range state.Inventory {
		found = found || item.ID == purchase.ID && item.ItemKey == "tree"
	}
	if !found {
		t.Fatal("island capability lost")
	}
}

// 已售商品不能换成另一物品，避免历史实例混入新商品拥有数量。
func TestIslandSoldItemIdentityCannotChange(t *testing.T) {
	f := newShopFixture(t)
	input := shop.ProductInput{Type: "island", Name: "树", AssetKey: "island-tree-v1", Enabled: true}
	product := createProduct(t, f, input)
	buyProduct(t, f, product)
	buyProduct(t, f, product)
	for _, key := range []string{"island-cottage-v1", "island-ball-v1"} {
		input.AssetKey = key
		_, err := f.Service.UpdateProduct(context.Background(), f.Principal, product.ID, shop.ProductUpdate{ProductInput: input, ExpectedVersion: product.Version})
		requireShopCode(t, err, "PRODUCT_ITEM_LOCKED")
	}
	input.AssetKey = "island-tree-v1"
	input.CoinPrice = 18
	updated, err := f.Service.UpdateProduct(context.Background(), f.Principal, product.ID, shop.ProductUpdate{ProductInput: input, ExpectedVersion: product.Version})
	if err != nil || updated.OwnedCount != 2 {
		t.Fatalf("same identity %+v %v", updated, err)
	}
}

// 成交图片退出当前目录后，稳定物品身份仍提供当前岛屿与画像能力。
func TestIslandStableIdentityOutlivesThumbnailVersion(t *testing.T) {
	f := newShopFixture(t)
	product := createProduct(t, f, shop.ProductInput{Type: "island", Name: "树", AssetKey: "island-tree-v1", Enabled: true})
	purchase := buyProduct(t, f, product).Purchase
	if _, err := f.DB.Exec("UPDATE purchases SET asset_key_snapshot='retired-tree-v0' WHERE id=?", purchase.ID); err != nil {
		t.Fatal(err)
	}
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range state.Inventory {
		found = found || item.ID == purchase.ID && item.ItemKey == "tree"
	}
	if !found {
		t.Fatal("stable item lost")
	}
	list, err := f.Service.ListPurchases(context.Background(), f.Principal, shop.PurchaseQuery{Type: "accessory", Status: "owned"})
	if err != nil || len(list.Items) != 1 || list.Items[0].PortraitAssetKey != "accessory-tree-v1" {
		t.Fatalf("portrait %+v %v", list, err)
	}
	offers, err := f.Service.ListProducts(context.Background(), f.Principal, false)
	if err != nil || len(offers.Items) != 1 || offers.Items[0].OwnedCount != 1 {
		t.Fatalf("offers %+v %v", offers, err)
	}
}
