package shop_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/internal/wallet"
	"github.com/wookiisky/check-in-suite/migrations"
)

// shopFixture keeps independent real SQLite connections on one household database.
type shopFixture struct {
	DB        *sql.DB           // Primary service connection.
	Other     *sql.DB           // Independent contender, never a shared pool goroutine.
	Accounts  *account.Service  // Real credential authority.
	Service   *shop.Service     // Primary shop service.
	Contender *shop.Service     // Shop using the other connection.
	Principal account.Principal // Authenticated and unlocked household session.
	Now       time.Time         // Stable timestamp shared by both services.
}

// newShopFixture initializes only the account and real-file business schema.
func newShopFixture(t *testing.T) shopFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "shop.db")
	db, err := storage.Open(ctx, path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	other, err := storage.Open(ctx, path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { other.Close() })
	cfg := config.Defaults()
	now := time.Date(2026, 10, 29, 4, 0, 0, 0, time.UTC)
	a := account.New(db, cfg)
	a.Now = func() time.Time { return now }
	if err = a.Initialize(ctx, "shop-test", "小朋友", "shop-login-password", "shop-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := a.Login(ctx, "shop-test", "shop-login-password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Unlock(ctx, p, "shop-management-password"); err != nil {
		t.Fatal(err)
	}
	b := account.New(other, cfg)
	b.Now = a.Now
	s := shop.New(db, cfg, a)
	s.Now = a.Now
	s2 := shop.New(other, cfg, b)
	s2.Now = a.Now
	return shopFixture{db, other, a, s, s2, p, now}
}

// creditFixture adds a real check-in and matching immutable grant before shopping.
func creditFixture(t *testing.T, f shopFixture, coins, diamonds int64) wallet.Balance {
	t.Helper()
	ctx := context.Background()
	tx, err := f.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	taskID, recordID := core.ID(), core.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,created_at,updated_at) VALUES(?,?,'book-v1',?,?,1,127,1,?,?)", taskID, "测试任务", coins, diamonds, f.Now.UnixMilli(), f.Now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,source,created_at,updated_at) VALUES(?,?,'2026-10-29',?,'book-v1',?,?,'today',?,?)", recordID, taskID, "测试任务", coins, diamonds, f.Now.UnixMilli(), f.Now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	b, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.CheckinGrant, ResourceID: recordID, Coins: coins, Diamonds: diamonds, At: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return b
}

// readBalance verifies the cached wallet against both sums of immutable entries.
func readBalance(t *testing.T, f shopFixture) wallet.Balance {
	t.Helper()
	ctx := context.Background()
	tx, err := f.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	b, err := wallet.Get(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	var coins, diamonds int64
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(coin_delta),0),COALESCE(SUM(diamond_delta),0) FROM wallet_entries").Scan(&coins, &diamonds); err != nil {
		t.Fatal(err)
	}
	if b.Coins != coins || b.Diamonds != diamonds {
		t.Fatalf("wallet=%+v ledger=(%d,%d)", b, coins, diamonds)
	}
	return b
}

// requireShopCode compares the stable error contract, never localized copy.
func requireShopCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *core.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error=%v want=%s", err, code)
	}
}

// productInput supplies valid controlled artwork for each product type.
func productInput(kind string) shop.ProductInput {
	keys := map[string]string{"title": "title-crown-v1", "avatar": "bunny-v1", "accessory": "accessory-star-v1", "reward": "reward-gift-v1"}
	return shop.ProductInput{Type: kind, Name: "测试商品", AssetKey: keys[kind], Enabled: true}
}

// createProduct creates a managed product through the actual business service.
func createProduct(t *testing.T, f shopFixture, input shop.ProductInput) shop.Product {
	t.Helper()
	p, err := f.Service.CreateProduct(context.Background(), f.Principal, core.ID(), input)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// buyProduct executes one fresh purchase using the currently confirmed wallet.
func buyProduct(t *testing.T, f shopFixture, p shop.Product) shop.PurchaseResult {
	t.Helper()
	balance := readBalance(t, f)
	r, err := f.Service.Buy(context.Background(), f.Principal, core.ID(), shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: p.Version, ExpectedWalletVersion: balance.Version})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
