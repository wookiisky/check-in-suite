package message

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// messageFixture keeps a real file database and authenticated ordinary session for service tests.
type messageFixture struct {
	Service   *Service          // Service with a fixed clock, allowing exact timestamp ties.
	Accounts  *account.Service  // Real session authority used by revocation tests.
	Principal account.Principal // Ordinary login without management authorization.
	Path      string            // Database path for independent-connection competition.
}

// setupMessages creates a migrated database without demonstration business data.
func setupMessages(t *testing.T) messageFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "messages.db")
	db, err := storage.Open(ctx, path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	accounts := account.New(db, cfg)
	now := func() time.Time { return time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC) }
	accounts.Now = now
	if err := accounts.Initialize(ctx, "family", "小岛", "login-password", "manage-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := accounts.Login(ctx, "family", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	service := New(db, cfg)
	service.Now = now
	return messageFixture{service, accounts, p, path}
}

// requireCode compares stable machine codes instead of changeable user-facing copy.
func requireCode(t *testing.T, err error, want string) {
	t.Helper()
	var failure *core.Error
	if !errors.As(err, &failure) || failure.Code != want {
		t.Fatalf("error=%v want %s", err, want)
	}
}
