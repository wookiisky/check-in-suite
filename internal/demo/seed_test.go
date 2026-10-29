package demo

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// demoDatabase uses a real isolated SQLite file and the production migration set.
func demoDatabase(t *testing.T) (*sql.DB, config.Config) {
	t.Helper()
	directory := t.TempDir()
	cfg := config.Defaults()
	cfg.DatabasePath = filepath.Join(directory, "island.db")
	cfg.AssetsDirectory = filepath.Join(directory, "assets")
	db, err := storage.Open(context.Background(), cfg.DatabasePath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	return db, cfg
}

// countRows keeps test assertions at the persisted database boundary.
func countRows(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(query).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// TestSeedPopulatesUsableHistory verifies credentials, complete artwork coverage and economic facts.
func TestSeedPopulatesUsableHistory(t *testing.T) {
	ctx := context.Background()
	db, cfg := demoDatabase(t)
	passwordMin := cfg.Limits.PasswordMin
	result, err := Seed(ctx, db, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped || result.Tasks == 0 || result.Achievements == 0 || result.Products == 0 || result.Checkins == 0 || result.Purchases == 0 {
		t.Fatalf("result=%+v", result)
	}
	if cfg.Limits.PasswordMin != passwordMin {
		t.Fatal("formal configuration mutated")
	}
	service := account.New(db, cfg)
	token, _, err := service.Login(ctx, "user", "pass")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := service.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Unlock(ctx, principal, "pass"); err != nil {
		t.Fatal(err)
	}
	items, err := assets.New(cfg.AssetsDirectory).List()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Free {
			continue
		}
		var count int
		if err := db.QueryRow(`SELECT (SELECT count(*) FROM tasks WHERE icon_key=?)+(SELECT count(*) FROM achievements WHERE asset_key=?)+(SELECT count(*) FROM products WHERE asset_key=?)`, item.Key, item.Key, item.Key).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			t.Errorf("unreferenced artwork %s", item.Key)
		}
	}
	if countRows(t, db, `SELECT count(*) FROM pragma_foreign_key_check`) != 0 {
		t.Fatal("foreign key violation")
	}
	if countRows(t, db, `SELECT count(*) FROM wallets WHERE coins != (SELECT sum(coin_delta) FROM wallet_entries) OR diamonds != (SELECT sum(diamond_delta) FROM wallet_entries)`) != 0 {
		t.Fatal("wallet does not equal ledger")
	}
	if countRows(t, db, `SELECT count(DISTINCT business_date) FROM checkins`) == 0 {
		t.Fatal("completion history absent")
	}
	if countRows(t, db, `SELECT count(*) FROM purchases WHERE status='pending'`) == 0 || countRows(t, db, `SELECT count(*) FROM purchases WHERE status='redeemed'`) == 0 {
		t.Fatal("reward lifecycle absent")
	}
	equipment, err := shop.New(db, cfg, service).Equipment(ctx, principal)
	if err != nil || equipment.BaseAvatarKey != assets.DefaultAvatar || equipment.Avatar != nil || equipment.Wearables.Hair == nil || equipment.Wearables.Top == nil || equipment.Wearables.Bottom == nil || equipment.Wearables.Shoes == nil {
		t.Fatalf("demo missing composed human outfit: %+v %v", equipment, err)
	}
	if countRows(t, db, `SELECT count(*) FROM products WHERE asset_key IN ('avatar-boy-v2','avatar-girl-v2','default-top-v1','default-bottom-v1','default-shoes-v1')`) != 0 {
		t.Fatal("free or internal assets became products")
	}
	state, err := island.New(db, time.Now).Read(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Inventory) == 0 || len(state.Placements) == 0 {
		t.Fatalf("island=%+v", state)
	}
	if _, err := island.New(db, time.Now).Save(ctx, principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements}); err != nil {
		t.Fatalf("seeded layout invalid: %v", err)
	}
}

// TestSeedRepeatDoesNotRewriteChanges verifies that a completion marker permits a harmless rerun.
func TestSeedRepeatDoesNotRewriteChanges(t *testing.T) {
	db, cfg := demoDatabase(t)
	if _, err := Seed(context.Background(), db, cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE tasks SET name='Edited by tester' WHERE id=(SELECT id FROM tasks LIMIT 1)`); err != nil {
		t.Fatal(err)
	}
	before := countRows(t, db, `SELECT count(*) FROM checkins`)
	result, err := Seed(context.Background(), db, cfg)
	if err != nil || !result.Skipped {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	if countRows(t, db, `SELECT count(*) FROM checkins`) != before || countRows(t, db, `SELECT count(*) FROM tasks WHERE name='Edited by tester'`) != 1 {
		t.Fatal("rerun rewrote data")
	}
}

// TestSeedRefusesExistingAccount verifies the single-household contract even for a matching username.
func TestSeedRefusesExistingAccount(t *testing.T) {
	db, cfg := demoDatabase(t)
	if err := account.New(db, cfg).Initialize(context.Background(), "user", "正式账户", "long login password", "long manage password"); err != nil {
		t.Fatal(err)
	}
	_, err := Seed(context.Background(), db, cfg)
	var domain *core.Error
	if !errors.As(err, &domain) || domain.Code != "DEMO_REQUIRES_EMPTY_DATABASE" {
		t.Fatalf("error=%v", err)
	}
	if countRows(t, db, `SELECT count(*) FROM tasks`) != 0 {
		t.Fatal("existing account modified")
	}
}

// TestSeedFinalFailureRollsBackEverything proves retryability after the final database statement fails.
func TestSeedFinalFailureRollsBackEverything(t *testing.T) {
	db, cfg := demoDatabase(t)
	if _, err := db.Exec(`CREATE TRIGGER reject_demo_completion BEFORE INSERT ON demo_seeds BEGIN SELECT RAISE(ABORT,'injected completion failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(context.Background(), db, cfg); err == nil {
		t.Fatal("expected final-write failure")
	}
	for _, table := range []string{"accounts", "wallets", "tasks", "products", "checkins", "wallet_entries", "demo_seeds"} {
		if countRows(t, db, "SELECT count(*) FROM "+table) != 0 {
			t.Errorf("%s survived rollback", table)
		}
	}
	if _, err := db.Exec(`DROP TRIGGER reject_demo_completion`); err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(context.Background(), db, cfg); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
}

// TestSeedRefusesUnmarkedBusinessData preserves even a database without an initialized account.
func TestSeedRefusesUnmarkedBusinessData(t *testing.T) {
	db, cfg := demoDatabase(t)
	if _, err := db.Exec(`INSERT INTO messages(id,text,created_at) VALUES('existing','Existing family message',1)`); err != nil {
		t.Fatal(err)
	}
	_, err := Seed(context.Background(), db, cfg)
	var domain *core.Error
	if !errors.As(err, &domain) || domain.Code != "DEMO_REQUIRES_EMPTY_DATABASE" {
		t.Fatalf("error=%v", err)
	}
	if countRows(t, db, `SELECT count(*) FROM accounts`) != 0 || countRows(t, db, `SELECT count(*) FROM messages`) != 1 {
		t.Fatal("partial or existing data changed")
	}
}

// TestSeedSupportsNormalBusinessChanges verifies seeded snapshots through real delete and redeem services.
func TestSeedSupportsNormalBusinessChanges(t *testing.T) {
	ctx := context.Background()
	db, cfg := demoDatabase(t)
	if _, err := Seed(ctx, db, cfg); err != nil {
		t.Fatal(err)
	}
	accounts := account.New(db, cfg)
	token, _, err := accounts.Login(ctx, "user", "pass")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := accounts.Unlock(ctx, principal, "pass"); err != nil {
		t.Fatal(err)
	}
	var id string
	var coins, diamonds int64
	if err := db.QueryRow(`SELECT id,coin_reward_snapshot,diamond_reward_snapshot FROM checkins ORDER BY business_date LIMIT 1`).Scan(&id, &coins, &diamonds); err != nil {
		t.Fatal(err)
	}
	var oldCoins, oldDiamonds int64
	if err := db.QueryRow(`SELECT coins,diamonds FROM wallets WHERE account_id=1`).Scan(&oldCoins, &oldDiamonds); err != nil {
		t.Fatal(err)
	}
	deleted, err := checkin.New(db, accounts, cfg).Delete(ctx, principal, true, id, 1)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Wallet.Coins != oldCoins-coins || deleted.Wallet.Diamonds != oldDiamonds-diamonds {
		t.Fatal("historical reward was not revoked")
	}
	if countRows(t, db, `SELECT count(*) FROM achievements WHERE metric='count' AND progress != (SELECT count(*) FROM checkins WHERE deleted_at IS NULL)`) != 0 {
		t.Fatal("achievement did not reconcile")
	}
	if err := db.QueryRow(`SELECT id FROM purchases WHERE status='pending' LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	purchase, err := shop.New(db, cfg, accounts).Redeem(ctx, principal, id, "pass")
	if err != nil || purchase.Status != shop.StatusRedeemed {
		t.Fatalf("purchase=%+v error=%v", purchase, err)
	}
	if countRows(t, db, `SELECT count(*) FROM wallets WHERE coins != (SELECT sum(coin_delta) FROM wallet_entries) OR diamonds != (SELECT sum(diamond_delta) FROM wallet_entries)`) != 0 {
		t.Fatal("ledger changed inconsistently")
	}
}
