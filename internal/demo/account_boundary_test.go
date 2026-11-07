package demo

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// TestDemoPopulationRechecksAccountState exercises the transaction boundary after the initial empty check becomes stale.
func TestDemoPopulationRechecksAccountState(t *testing.T) {
	ctx := context.Background()
	db, cfg := demoDatabase(t)
	accounts := account.New(db, cfg)
	complete, occupied, err := inspect(ctx, db)
	if err != nil || complete || occupied {
		t.Fatalf("initial state: %t %t %v", complete, occupied, err)
	}
	// Another initializer commits after the demo's initial inspection and before its write transaction.
	if err := accounts.Initialize(ctx, "real-user", "real-user", "login-password", "manage-password"); err != nil {
		t.Fatal(err)
	}
	err = accounts.InitializeWith(ctx, "demo-user", "demo-user", "login-password", "manage-password", func(tx *sql.Tx) error {
		return requireEmptyBusiness(ctx, tx)
	})
	var domain *core.Error
	if !errors.As(err, &domain) || domain.Code != "DEMO_REQUIRES_EMPTY_DATABASE" {
		t.Fatalf("populated a previously initialized database: %v", err)
	}
	if countRows(t, db, "SELECT count(*) FROM accounts") != 1 || countRows(t, db, "SELECT count(*) FROM wallets") != 1 {
		t.Fatal("demo account survived rejected population")
	}
}
