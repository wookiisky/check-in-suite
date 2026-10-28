package account

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
)

// secondService opens a separate pool over the same file to establish real SQLite competition.
func secondService(t *testing.T, s *Service) *Service {
	t.Helper()
	var sequence int
	var name, path string
	if err := s.DB.QueryRow("PRAGMA database_list").Scan(&sequence, &name, &path); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	other := New(db, s.Config)
	other.Now = s.Now
	return other
}

// initializeSession creates real credentials and returns a valid principal for concurrency tests.
func initializeSession(t *testing.T, s *Service) (string, Principal) {
	t.Helper()
	ctx := context.Background()
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
	return token, p
}

// blockVerification exposes the moment after the old hash was read and before authorization is written.
func blockVerification(s *Service) (<-chan struct{}, chan<- struct{}) {
	started := make(chan struct{})
	release := make(chan struct{})
	s.verify = func(hash, password string) bool {
		valid := verifyPassword(hash, password)
		close(started)
		<-release
		return valid
	}
	return started, release
}

// TestPasswordResetWinsOverOldLogin proves a successful old hash check cannot mint a new session.
func TestPasswordResetWinsOverOldLogin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := setupAccount(t)
	initializeSession(t, s)
	other := secondService(t, s)
	started, release := blockVerification(s)
	result := make(chan error, 1)
	go func() { _, _, err := s.Login(ctx, "island", "login password"); result <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := other.ResetPassword(ctx, "login", "replacement password"); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	assertCode(t, <-result, "INVALID_CREDENTIALS")
	var count int
	if err := s.DB.QueryRowContext(ctx, "SELECT count(*) FROM sessions").Scan(&count); err != nil || count != 0 {
		t.Fatalf("sessions=%d %v", count, err)
	}
}

// TestLockWinsOverDelayedUnlock proves leaving management cannot be undone by an in-flight hash check.
func TestLockWinsOverDelayedUnlock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := setupAccount(t)
	_, p := initializeSession(t, s)
	other := secondService(t, s)
	started, release := blockVerification(s)
	result := make(chan error, 1)
	go func() { _, err := s.Unlock(ctx, p, "manage password"); result <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := other.Lock(ctx, p); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	assertCode(t, <-result, "MANAGEMENT_CHANGED")
	var expiry sql.NullInt64
	if err := s.DB.QueryRowContext(ctx, "SELECT management_expires_at FROM sessions WHERE id=?", p.SessionID).Scan(&expiry); err != nil || expiry.Valid {
		t.Fatalf("expiry=%v %v", expiry, err)
	}
}

// TestExpirationAndFailureCooldown checks expiry boundaries without wall-clock sleeps.
func TestExpirationAndFailureCooldown(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	token, p := initializeSession(t, s)
	if _, err := s.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	initial := s.Now()
	s.Now = func() time.Time { return initial.Add(s.Config.ManagementTTL) }
	_, err := s.UpdateProfile(ctx, p, "名字", 1)
	assertCode(t, err, "MANAGEMENT_REQUIRED")
	s.Now = func() time.Time { return initial.Add(s.Config.SessionTTL) }
	_, err = s.Authenticate(ctx, token)
	assertCode(t, err, "SESSION_REQUIRED")
	for i := 0; i < 10; i++ {
		s.failedAttempt("login")
	}
	_, _, err = s.Login(ctx, "island", "login password")
	assertCode(t, err, "TOO_MANY_ATTEMPTS")
	s.Now = func() time.Time { return initial.Add(s.Config.SessionTTL + time.Minute) }
	if _, _, err = s.Login(ctx, "island", "login password"); err != nil {
		t.Fatal(err)
	}
}

// TestAuthorizationRecheckedAfterLogout refuses work holding an earlier authenticated principal.
func TestAuthorizationRecheckedAfterLogout(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	_, p := initializeSession(t, s)
	other := secondService(t, s)
	if _, err := s.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	if err := other.Logout(ctx, p); err != nil {
		t.Fatal(err)
	}
	_, err := s.UpdateProfile(ctx, p, "不应写入", 1)
	assertCode(t, err, "SESSION_REQUIRED")
}
