package shop_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// 初始化目录可以重试，已创建商品的价格、库存和上下架状态不会被覆盖。
func TestIslandSeedRetainsManagedValues(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "seed.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	if err = shop.SeedIslandProducts(ctx, db, 1); err != nil {
		t.Fatal(err)
	}
	var initialCount int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&initialCount); err != nil || initialCount == 0 {
		t.Fatalf("initial catalog count=%d %v", initialCount, err)
	}
	if _, err = db.ExecContext(ctx, "UPDATE products SET coin_price=99,stock=2,enabled=0 WHERE id='island-offer-tree'"); err != nil {
		t.Fatal(err)
	}
	if err = shop.SeedIslandProducts(ctx, db, 2); err != nil {
		t.Fatal(err)
	}
	var coins, stock, enabled, count int
	if err = db.QueryRowContext(ctx, "SELECT coin_price,stock,enabled FROM products WHERE id='island-offer-tree'").Scan(&coins, &stock, &enabled); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if coins != 99 || stock != 2 || enabled != 0 || count != initialCount {
		t.Fatalf("seed changed offer: coins=%d stock=%d enabled=%d count=%d", coins, stock, enabled, count)
	}
}
