package shop_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// 全新安装只上架声明报价的物件，单纯扩充素材不能产生商品。
func TestSupplementalArtworkDoesNotSeedOffers(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "artwork.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedIslandProducts(ctx, db, 1); err != nil {
		t.Fatal(err)
	}
	for _, item := range island.Catalog() {
		var count int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM products WHERE id=?", "island-offer-"+item.Key).Scan(&count); err != nil {
			t.Fatal(err)
		}
		want := 1
		if item.CatalogOnly || item.AssetKey == "" {
			want = 0
		}
		if count != want {
			t.Fatalf("offer %s count=%d want=%d", item.Key, count, want)
		}
	}
}
