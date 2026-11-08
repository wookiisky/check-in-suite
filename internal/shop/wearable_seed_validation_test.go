package shop

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// Published entries appear without commercial seed terms, and retirement preserves those terms.
func TestWearablePublicationSuppliesDisabledOfferAndRetainsTerms(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "seed-validation.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	publish := func(bindings []dressUpOfferBinding, now int64) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if err := syncDressUpOffers(ctx, tx, 1, now, TypeWearable, bindings, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	bindings := []dressUpOfferBinding{{Key: "future-garment", Name: "新衣物", Thumbnail: "new-thumbnail", Model: "new-model"}}
	publish(bindings, 1)

	var asset, name string
	var price, enabled, version int64
	read := func() {
		t.Helper()
		if err := db.QueryRow("SELECT asset_key,name,coin_price,enabled,version FROM products WHERE wearable_key=?", bindings[0].Key).Scan(&asset, &name, &price, &enabled, &version); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if asset != "" || name != bindings[0].Name || price != 0 || enabled != 0 || version != 1 {
		t.Fatalf("initial offer: artwork=%q name=%q price=%d enabled=%d version=%d", asset, name, price, enabled, version)
	}
	if _, err := db.Exec("UPDATE products SET name='账户商品名',coin_price=23,enabled=1,version=2"); err != nil {
		t.Fatal(err)
	}
	publish(nil, 2)
	var visible int
	if err := db.QueryRow("SELECT count(*) FROM products p WHERE p.enabled=1" + catalogOfferFilter).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("retired listing visible: count=%d err=%v", visible, err)
	}
	publish(bindings, 3)
	read()
	if asset != "" || name != "账户商品名" || price != 23 || enabled != 1 || version != 4 {
		t.Fatalf("restored offer: artwork=%q name=%q price=%d enabled=%d version=%d", asset, name, price, enabled, version)
	}
	if _, err := db.Exec(`INSERT INTO products(id,type,name,asset_key,wearable_key,coin_price,diamond_price,enabled,created_at,updated_at)
		VALUES('duplicate','wearable','同款','','future-garment',0,0,1,1,1)`); err == nil {
		t.Fatal("database accepted duplicate account listing")
	}
}
