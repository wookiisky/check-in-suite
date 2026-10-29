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

// 补充素材不改变全新安装已有的六项默认商品。
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
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM products").Scan(&count); err != nil || count != 6 {
		t.Fatalf("default offers changed: %d, %v", count, err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM products WHERE asset_key IN ('island-flowers-v1','island-tent-v1','island-windmill-v1')").Scan(&count); err != nil || count != 0 {
		t.Fatalf("supplemental artwork was priced automatically: %d, %v", count, err)
	}
}
