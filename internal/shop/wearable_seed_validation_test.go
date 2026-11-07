package shop

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// 默认资格由所有基础身体共同声明，初始化报价不能出售其他身体的默认项或空穿戴。
func TestWearableSeedRejectsEveryBodyDefault(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "seed-validation.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	original := wearableProductsJSON
	t.Cleanup(func() { wearableProductsJSON = original })
	for _, body := range character.Definitions() {
		for _, slot := range character.Slots() {
			key := body.Defaults.ForSlot(slot)
			t.Run(body.Key+"/"+string(slot), func(t *testing.T) {
				item, ok := character.GetWearable(key)
				if !ok {
					t.Fatalf("missing default %s", key)
				}
				wearableProductsJSON, err = json.Marshal([]wearableOffer{{WearableKey: item.Key, Name: item.Name}})
				if err != nil {
					t.Fatal(err)
				}
				if err = seedWearableProducts(ctx, db, 1, 1); err == nil {
					t.Fatalf("seed accepted default %s with source %s", key, item.CharacterKey)
				}
				var count int
				if err = db.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&count); err != nil || count != 0 {
					t.Fatalf("invalid seed committed products=%d err=%v", count, err)
				}
			})
		}
	}
}
