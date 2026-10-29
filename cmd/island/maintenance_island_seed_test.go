package main

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestIslandSeedFailureAllowsInitializationRetry exercises a real SQLite write failure and retry.
func TestIslandSeedFailureAllowsInitializationRetry(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "initialize.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER fail_island_seed BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT, 'seed-write-failed'); END`); err != nil {
		t.Fatal(err)
	}
	service := account.New(db, config.Defaults())
	input := "family\n小岛\nlogin-password\nlogin-password\nmanage-password\nmanage-password\n"
	var output bytes.Buffer
	if err := maintain(ctx, "init", "", service, strings.NewReader(input), &output); err == nil {
		t.Fatal("initialization accepted failed product writes")
	}
	var accounts, products int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM accounts").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM products").Scan(&products); err != nil {
		t.Fatal(err)
	}
	if accounts != 0 || products != 0 {
		t.Fatalf("failed initial state: accounts=%d products=%d", accounts, products)
	}
	if _, err := db.ExecContext(ctx, "DROP TRIGGER fail_island_seed"); err != nil {
		t.Fatal(err)
	}
	if err := maintain(ctx, "init", "", service, strings.NewReader(input), &output); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM accounts").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM products WHERE type='island'").Scan(&products); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 || products < 5 {
		t.Fatalf("recovered initial state: accounts=%d products=%d", accounts, products)
	}
}
