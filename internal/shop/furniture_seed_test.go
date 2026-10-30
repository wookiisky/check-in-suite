package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 新家具补入已有账户，但旧版商品不会因升级重新上架。
func TestFurnitureSeedAddsOffersToExistingAccount(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedIslandProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"bed", "dining-table", "dining-chair", "sofa", "coffee-table", "television", "cabinet", "refrigerator", "kitchen-counter", "toilet", "washbasin", "shower"} {
		var assetKey string
		var enabled, diamonds int
		if err := f.DB.QueryRowContext(ctx, "SELECT asset_key,enabled,diamond_price FROM products WHERE id=?", "island-offer-"+key).Scan(&assetKey, &enabled, &diamonds); err != nil {
			t.Fatalf("furniture %s was not added: %v", key, err)
		}
		definition, found := island.ForAsset(assetKey)
		if !found || definition.Key != key || !definition.Repeatable || !assets.Valid(assetKey, assets.KindIsland) || enabled != 1 || diamonds != 0 {
			t.Fatalf("invalid furniture offer %s: %+v enabled=%d diamonds=%d", key, definition, enabled, diamonds)
		}
	}
	var count int
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products WHERE id='island-offer-tree'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("old offer was unexpectedly restored: count=%d error=%v", count, err)
	}
}

// 再次升级不得覆盖管理价格库存，也不能恢复下架或软删除的家具。
func TestFurnitureSeedRetainsManagedAndDeletedOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedIslandProducts(ctx, f.DB, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.ExecContext(ctx, "UPDATE products SET coin_price=99,stock=2,enabled=0,version=3 WHERE id='island-offer-bed'"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.ExecContext(ctx, "UPDATE products SET deleted_at=2,version=4 WHERE id='island-offer-dining-chair'"); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedIslandProducts(ctx, f.DB, 3); err != nil {
		t.Fatal(err)
	}
	var coins, stock, enabled, version, updated int
	if err := f.DB.QueryRowContext(ctx, "SELECT coin_price,stock,enabled,version,updated_at FROM products WHERE id='island-offer-bed'").Scan(&coins, &stock, &enabled, &version, &updated); err != nil {
		t.Fatal(err)
	}
	if coins != 99 || stock != 2 || enabled != 0 || version != 3 || updated != 1 {
		t.Fatalf("managed offer changed: coins=%d stock=%d enabled=%d version=%d updated=%d", coins, stock, enabled, version, updated)
	}
	var deleted int
	if err := f.DB.QueryRowContext(ctx, "SELECT deleted_at,version FROM products WHERE id='island-offer-dining-chair'").Scan(&deleted, &version); err != nil || deleted != 2 || version != 4 {
		t.Fatalf("deleted offer changed: deleted=%d version=%d error=%v", deleted, version, err)
	}
}

// 数据库中途拒绝一件新品时，同批家具不得留下部分上架结果。
func TestFurnitureSeedRollsBackEntireBatch(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if _, err := f.DB.ExecContext(ctx, "CREATE TRIGGER reject_furniture BEFORE INSERT ON products WHEN NEW.id='island-offer-refrigerator' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END"); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedIslandProducts(ctx, f.DB, 1); err == nil {
		t.Fatal("expected the database trigger to reject this batch")
	}
	var count int
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial offers remained after rollback: count=%d error=%v", count, err)
	}
	if _, err := f.DB.ExecContext(ctx, "DROP TRIGGER reject_furniture"); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedIslandProducts(ctx, f.DB, 2); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&count); err != nil || count != 12 {
		t.Fatalf("retry did not complete the furniture batch: count=%d error=%v", count, err)
	}
}

// 真实购买沿用幂等扣款，每把餐椅都成为独立的营地库存实例。
func TestFurniturePurchaseGrantsRepeatableInventory(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := shop.SeedIslandProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	balance := creditFixture(t, f, 100, 0)
	definition, found := island.Find("dining-chair")
	if !found {
		t.Fatal("dining chair has no definition")
	}
	input := shop.BuyInput{ProductID: "island-offer-dining-chair", ExpectedProductVersion: 1, ExpectedWalletVersion: balance.Version}
	key := core.ID()
	first, err := f.Service.Buy(ctx, f.Principal, key, input)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := f.Service.Buy(ctx, f.Principal, key, input)
	if err != nil || replayed.Purchase.ID != first.Purchase.ID {
		t.Fatalf("replayed purchase: %+v error=%v", replayed, err)
	}
	input.ExpectedWalletVersion = first.Wallet.Version
	second, err := f.Service.Buy(ctx, f.Principal, core.ID(), input)
	if err != nil || second.Purchase.ID == first.Purchase.ID || second.Wallet.Coins != balance.Coins-2*definition.CoinPrice {
		t.Fatalf("second chair purchase: %+v error=%v", second, err)
	}
	state, err := island.New(f.DB, f.Accounts.Now).Read(ctx, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	owned := make(map[string]string)
	for _, item := range state.Inventory {
		owned[item.ID] = item.ItemKey
	}
	if owned[first.Purchase.ID] != "dining-chair" || owned[second.Purchase.ID] != "dining-chair" {
		t.Fatalf("missing independent chair inventory: %+v", state.Inventory)
	}
}
