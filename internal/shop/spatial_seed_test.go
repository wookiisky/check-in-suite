package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestSpatialSeedRetainsManagedOffers 保留管理员配置，免费初始款不产生商品。
func TestSpatialSeedRetainsManagedOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedSpatialProducts(ctx, f.DB, 1); err != nil {
		t.Fatal(err)
	}
	var count, want int
	for _, item := range island.SpatialCatalog() {
		if !item.Free {
			want++
		}
	}
	if err := f.DB.QueryRow(`SELECT count(*) FROM products WHERE id LIKE 'spatial-offer-%'`).Scan(&count); err != nil || count != want {
		t.Fatalf("seed count=%d want=%d err=%v", count, want, err)
	}
	if _, err := f.DB.Exec(`UPDATE products SET coin_price=99,stock=2,enabled=0,deleted_at=1 WHERE id='spatial-offer-camp-tree-v1'`); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedSpatialProducts(ctx, f.DB, 2); err != nil {
		t.Fatal(err)
	}
	var coins, stock, enabled, deleted int
	if err := f.DB.QueryRow(`SELECT coin_price,stock,enabled,deleted_at FROM products WHERE id='spatial-offer-camp-tree-v1'`).Scan(&coins, &stock, &enabled, &deleted); err != nil {
		t.Fatal(err)
	}
	if coins != 99 || stock != 2 || enabled != 0 || deleted != 1 {
		t.Fatalf("managed values changed: %d %d %d %d", coins, stock, enabled, deleted)
	}
}

// TestSpatialPurchaseSnapshot 真实购买保留物件快照、跨商品所有权和重复实例。
func TestSpatialPurchaseSnapshot(t *testing.T) {
	f := newShopFixture(t)
	balance := creditFixture(t, f, 100, 0)
	ctx := context.Background()
	product := createProduct(t, f, shop.ProductInput{Type: shop.TypeIsland, Name: "三维椅子", AssetKey: "camp-dining-chair-v1-thumbnail", CoinPrice: 20, Enabled: true})
	if product.IslandItemKey != "camp-dining-chair-v1" || !product.Repeatable {
		t.Fatalf("missing spatial capability: %+v", product)
	}
	first, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: balance.Version})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: first.Wallet.Version})
	if err != nil {
		t.Fatal(err)
	}
	if first.Purchase.ID == second.Purchase.ID || first.Purchase.ItemKeySnapshot != "camp-dining-chair-v1" || first.Purchase.IslandItemKey != "camp-dining-chair-v1" {
		t.Fatalf("snapshot mismatch: %+v", first.Purchase)
	}
	other := createProduct(t, f, shop.ProductInput{Type: shop.TypeIsland, Name: "同款另售", AssetKey: product.AssetKey, Enabled: true})
	if !other.Owned || other.OwnedCount != 2 {
		t.Fatalf("cross-offer ownership lost: %+v", other)
	}
	_, err = f.Service.UpdateProduct(ctx, f.Principal, product.ID, shop.ProductUpdate{ExpectedVersion: product.Version, ProductInput: shop.ProductInput{Type: shop.TypeIsland, Name: product.Name, AssetKey: "camp-bed-v1-thumbnail", Enabled: true}})
	requireShopCode(t, err, "PRODUCT_ITEM_LOCKED")
	if _, err = f.DB.Exec(`UPDATE products SET deleted_at=1,name='改名' WHERE id=?`, product.ID); err != nil {
		t.Fatal(err)
	}
	state, err := island.New(f.DB, f.Accounts.Now).ReadSpatial(ctx, f.Principal)
	if err != nil || len(state.Inventory) != 5 {
		t.Fatalf("owned snapshot lost: %+v err=%v", state.Inventory, err)
	}
	for _, assetKey := range []string{"camp-house-v1-thumbnail", "camp-reading-desk-v1-thumbnail", "camp-sports-area-v1-thumbnail"} {
		t.Run(assetKey, func(t *testing.T) {
			_, err = f.Service.CreateProduct(ctx, f.Principal, core.ID(), shop.ProductInput{Type: shop.TypeIsland, Name: "免费初始款", AssetKey: assetKey, Enabled: true})
			requireShopCode(t, err, "INVALID_REQUEST")
		})
	}
}
