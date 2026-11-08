package shop_test

import (
	"context"
	"errors"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 场景商品使用正式场景身份，缩略图必须与目录一致。
func catalogSceneProduct(t *testing.T, key string) productFixture {
	t.Helper()
	scene, found := island.SpatialSceneFind(key)
	if !found || scene.Free {
		t.Fatalf("missing paid scene %q", key)
	}
	return productFixture{Type: shop.TypeScene, SceneKey: scene.Key, Name: scene.Name, AssetKey: scene.ThumbnailAssetKey, Enabled: true}
}

// 永久场景资格来自成交快照，不依赖仍在上架的报价，也不产生可摆放实例。
func TestScenePurchaseRetainsIdentityAndPreventsDuplicateOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := catalogSceneProduct(t, "forest-courtyard-v1")
	first, second := createProduct(t, f, input), createProduct(t, f, input)
	balance := readBalance(t, f)
	request := shop.BuyInput{ProductID: first.ID, ExpectedProductVersion: first.Version, ExpectedWalletVersion: balance.Version}
	key := core.ID()
	result, err := f.Service.Buy(ctx, f.Principal, key, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Purchase.SceneKey != input.SceneKey || result.Purchase.TypeSnapshot != shop.TypeScene || result.Purchase.IslandItemKey != "" {
		t.Fatalf("scene ownership snapshot=%+v", result.Purchase)
	}
	retireHistoricalProduct(t, f, first.ID)
	replay, err := f.Service.Buy(ctx, f.Principal, key, request)
	if err != nil || replay.Purchase.ID != result.Purchase.ID || replay.Purchase.SceneKey != input.SceneKey {
		t.Fatalf("scene replay=%+v err=%v", replay, err)
	}
	balance = readBalance(t, f)
	_, err = f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: second.ID, ExpectedProductVersion: second.Version, ExpectedWalletVersion: balance.Version})
	requireShopCode(t, err, "ALREADY_OWNED")
	page, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Type: shop.TypeScene, Limit: 1})
	if err != nil || len(page.Items) != 1 || !page.Items[0].Owned || page.Items[0].OwnedCount != 1 || page.Items[0].Repeatable {
		t.Fatalf("scene offer ownership=%+v err=%v", page, err)
	}
	orders, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: shop.TypeScene, Limit: 1})
	if err != nil || len(orders.Items) != 1 || orders.Items[0].SceneKey != input.SceneKey {
		t.Fatalf("scene orders=%+v err=%v", orders, err)
	}
}

// 同一场景的不同报价同时成交时，数据库只保留一次资格和一笔流水。
func TestSceneConcurrentOffersHaveSinglePurchase(t *testing.T) {
	f := newShopFixture(t)
	input := catalogSceneProduct(t, "forest-courtyard-v1")
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
			continue
		}
		var failure *core.Error
		if !errors.As(err, &failure) || (failure.Code != "WALLET_CHANGED" && failure.Code != "ALREADY_OWNED") {
			t.Fatalf("unexpected concurrent scene error: %v", err)
		}
	}
	var orders, entries int
	if err := f.DB.QueryRow("SELECT count(*) FROM purchases WHERE type_snapshot='scene'").Scan(&orders); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE event_type='purchase_debit'").Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if successes != 1 || orders != 1 || entries != 1 {
		t.Fatalf("success=%d orders=%d entries=%d errors=%v", successes, orders, entries, results)
	}
}

// 免费海边不能出售，编辑场景报价只会改变交易条件。
func TestSceneProductsBindSceneFromMaterial(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	free, ok := island.SpatialSceneFind("seaside-v1")
	if !ok || !free.Free {
		t.Fatal("expected free seaside scene")
	}
	input := catalogSceneProduct(t, "forest-courtyard-v1")
	invalid := input.createInput()
	invalid.AssetKey = free.ThumbnailAssetKey
	_, err := f.Service.CreateProduct(ctx, f.Principal, core.ID(), invalid)
	requireShopCode(t, err, "INVALID_REQUEST")
	product := createProduct(t, f, input)
	buyProduct(t, f, product)
	input.CoinPrice = 3
	updated, err := f.Service.UpdateProduct(ctx, f.Principal, product.ID, shop.ProductUpdate{ProductTerms: input.terms(), ExpectedVersion: product.Version})
	if err != nil || updated.SceneKey != input.SceneKey || updated.AssetKey != input.AssetKey || updated.CoinPrice != 3 {
		t.Fatalf("scene quote=%+v err=%v", updated, err)
	}
}

// 重试初始化保留管理员价格、库存、上下架和删除状态。
func TestSceneSeedPreservesManagedOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedSceneProducts(ctx, f.DB, 1); err != nil {
		t.Fatal(err)
	}
	list, err := f.Service.ListProductsPage(ctx, f.Principal, true, shop.ProductQuery{Type: shop.TypeScene, Limit: 100})
	if err != nil || len(list.Items) != 2 {
		t.Fatalf("seeded scenes=%+v err=%v", list, err)
	}
	for _, product := range list.Items {
		if product.SceneKey == "forest-courtyard-v1" && product.CoinPrice != 80 || product.SceneKey == "lakeside-garden-v1" && product.CoinPrice != 120 || product.DiamondPrice != 0 {
			t.Fatalf("scene price=%+v", product)
		}
	}
	first := list.Items[0]
	if _, err := f.DB.Exec("UPDATE products SET coin_price=7,stock=3,enabled=0 WHERE id=?", first.ID); err != nil {
		t.Fatal(err)
	}
	retireHistoricalProduct(t, f, list.Items[1].ID)
	if err := shop.SeedSceneProducts(ctx, f.DB, 2); err != nil {
		t.Fatal(err)
	}
	var price, stock, enabled, deleted int64
	if err := f.DB.QueryRow("SELECT coin_price,stock,enabled FROM products WHERE id=?", first.ID).Scan(&price, &stock, &enabled); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRow("SELECT count(*) FROM products WHERE type='scene' AND deleted_at IS NOT NULL").Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if price != 7 || stock != 3 || enabled != 0 || deleted != 1 {
		t.Fatalf("managed scene overwritten: price=%d stock=%d enabled=%d deleted=%d", price, stock, enabled, deleted)
	}
}
