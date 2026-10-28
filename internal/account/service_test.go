package account

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// setupAccount creates an isolated real-file database with deterministic time.
func setupAccount(t *testing.T) *Service {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "account.db"), 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	s := New(db, config.Defaults())
	s.Now = func() time.Time { return time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC) }
	return s
}

// assertCode verifies stable machine errors rather than translated wording.
func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var got *core.Error
	if !errors.As(err, &got) || got.Code != code {
		t.Fatalf("error=%v want=%s", err, code)
	}
}

// TestAccountLifecycle verifies initialization, separate credentials and session revocation.
func TestAccountLifecycle(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	if err := s.Initialize(ctx, "island", "小朋友", "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	assertCode(t, s.Initialize(ctx, "other", "名字", "login password", "manage password"), "ACCOUNT_EXISTS")
	_, _, err := s.Login(ctx, "island", "wrong password")
	assertCode(t, err, "INVALID_CREDENTIALS")
	token, session, err := s.Login(ctx, "island", "login password")
	if err != nil {
		t.Fatal(err)
	}
	if session.Today != "2026-10-29" || session.Account.DisplayName != "小朋友" || session.ManagementExpiresAt != nil {
		t.Fatalf("%+v", session)
	}
	p, err := s.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateProfile(ctx, p, "新名字", 1)
	assertCode(t, err, "MANAGEMENT_REQUIRED")
	if _, err = s.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	profile, err := s.UpdateProfile(ctx, p, " 新名字 ", 1)
	if err != nil || profile.Version != 2 || profile.DisplayName != "新名字" {
		t.Fatalf("%+v %v", profile, err)
	}
	_, err = s.UpdateProfile(ctx, p, "冲突", 1)
	assertCode(t, err, "VERSION_CONFLICT")
	on := true
	if _, err = s.UpdatePreferences(ctx, p, PreferencesPatch{MusicEnabled: &on}); err != nil {
		t.Fatal(err)
	}
	current, err := s.Session(ctx, p)
	if err != nil || current.Account.Version != 2 || !current.Account.Preferences.MusicEnabled {
		t.Fatalf("%+v %v", current, err)
	}
	if err = s.Lock(ctx, p); err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateProfile(ctx, p, "不允许", 2)
	assertCode(t, err, "MANAGEMENT_REQUIRED")
	if err = s.ResetPassword(ctx, "login", "new login password"); err != nil {
		t.Fatal(err)
	}
	_, err = s.Authenticate(ctx, token)
	assertCode(t, err, "SESSION_REQUIRED")
	_, _, err = s.Login(ctx, "island", "login password")
	assertCode(t, err, "INVALID_CREDENTIALS")
	if _, _, err = s.Login(ctx, "island", "new login password"); err != nil {
		t.Fatal(err)
	}
}

// TestPasswordValidation checks Unicode limits and credential changes revoke every login.
func TestPasswordValidation(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	assertCode(t, s.Initialize(ctx, "island", "小朋友", "short", "manage password"), "INVALID_REQUEST")
	if err := s.Initialize(ctx, "island", "小朋友", "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := s.Login(ctx, "island", "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, s.ChangePassword(ctx, p, "login", "wrong old password", "replacement password", "replacement password"), "MANAGEMENT_REQUIRED")
	if _, err = s.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	assertCode(t, s.ChangePassword(ctx, p, "management", "manage password", "new management", "mismatch"), "INVALID_REQUEST")
	if err = s.ChangePassword(ctx, p, "management", "manage password", "new management", "new management"); err != nil {
		t.Fatal(err)
	}
	_, err = s.Authenticate(ctx, token)
	assertCode(t, err, "SESSION_REQUIRED")
}
