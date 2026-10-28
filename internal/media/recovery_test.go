package media

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestAttachmentWinsCleanup uses two independent connections contending for the same SQLite write lock.
func TestAttachmentWinsCleanup(t *testing.T) {
	s, p := mediaFixture(t)
	ctx := context.Background()
	upload, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 2, 2)))
	if err != nil {
		t.Fatal(err)
	}
	otherDB, err := storage.Open(ctx, s.Config.DatabasePath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer otherDB.Close()
	other := New(otherDB, s.Accounts, s.Config)
	other.Now = func() time.Time { return fixtureTime.Add(25 * time.Hour) }
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(started); done <- other.Cleanup(ctx) }()
	<-started
	select {
	case err := <-done:
		t.Fatalf("cleanup bypassed held write lock: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if err := Replace(ctx, tx, References{}, References{PhotoID: &upload.ID}, fixtureTime, s.Config.MediaOrphanTTL); err != nil {
		t.Fatal(err)
	}
	insertAttachedRecord(t, tx, upload.ID)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	_, file, err := s.Open(ctx, p, upload.ID)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
}

// TestFailedDeletionRecovers retries deleting rows after a real filesystem removal failure.
func TestFailedDeletionRecovers(t *testing.T) {
	s, p := mediaFixture(t)
	ctx := context.Background()
	upload, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 2, 2)))
	if err != nil {
		t.Fatal(err)
	}
	var key string
	if err := s.DB.QueryRow("SELECT storage_key FROM media_files WHERE id=?", upload.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Config.MediaDirectory, key)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(path, "blocker")
	if err := os.WriteFile(blocker, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	s.Now = func() time.Time { return fixtureTime.Add(25 * time.Hour) }
	if err := s.Cleanup(ctx); err == nil {
		t.Fatal("deletion error hidden")
	}
	var state string
	if err := s.DB.QueryRow("SELECT state FROM media_files WHERE id=?", upload.ID).Scan(&state); err != nil || state != "deleting" {
		t.Fatalf("%s %v", state, err)
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = Replace(ctx, tx, References{}, References{PhotoID: &upload.ID}, s.Now(), s.Config.MediaOrphanTTL)
	mediaCode(t, err, "INVALID_MEDIA")
	tx.Rollback()
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	restarted := New(s.DB, s.Accounts, s.Config)
	restarted.Now = s.Now
	if err := restarted.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.QueryRow("SELECT state FROM media_files WHERE id=?", upload.ID).Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("%s %v", state, err)
	}
}

// TestRegistrationFailureLeavesOnlyRecoverableOrphan proves failed SQLite registration never reports success.
func TestRegistrationFailureLeavesOnlyRecoverableOrphan(t *testing.T) {
	s, p := mediaFixture(t)
	ctx := context.Background()
	if _, err := s.DB.Exec(`CREATE TRIGGER fail_media_registration BEFORE INSERT ON media_files BEGIN SELECT RAISE(ABORT,'injected failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 2, 2))); err == nil {
		t.Fatal("registration failure reported success")
	}
	entries, err := os.ReadDir(s.Config.MediaDirectory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("orphan files %v %v", entries, err)
	}
	path := filepath.Join(s.Config.MediaDirectory, entries[0].Name())
	old := fixtureTime.Add(-25 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	finish := s.protect(path)
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("in-flight file deleted: %v", err)
	}
	finish()
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan remained: %v", err)
	}
}

// TestCredentialRevocationDuringUpload prevents a completed slow upload from reusing an old session.
func TestCredentialRevocationDuringUpload(t *testing.T) {
	s, p := mediaFixture(t)
	reader := &pausedReader{Reader: bytes.NewReader(pngFixture(t, 2, 2)), Entered: make(chan struct{}), Continue: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, err := s.Upload(context.Background(), p, "photo", reader); done <- err }()
	<-reader.Entered
	if err := s.Accounts.ResetPassword(context.Background(), "login", "a replacement password"); err != nil {
		t.Fatal(err)
	}
	close(reader.Continue)
	mediaCode(t, <-done, "SESSION_REQUIRED")
	var count int
	if err := s.DB.QueryRow("SELECT COUNT(*) FROM media_files").Scan(&count); err != nil || count != 0 {
		t.Fatalf("revoked upload registered: %d %v", count, err)
	}
}

// insertAttachedRecord creates the actual database reference used by private-read and cleanup queries.
func insertAttachedRecord(t *testing.T, tx *sql.Tx, mediaID string) {
	t.Helper()
	if _, err := tx.Exec(`INSERT INTO tasks(id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,created_at,updated_at) VALUES('task','测试','book-v1',0,0,1,127,1,?,?)`, fixtureTime.UnixMilli(), fixtureTime.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,photo_media_id,source,created_at,updated_at) VALUES('record','task','2026-10-29','测试','book-v1',0,0,?,'today',?,?)`, mediaID, fixtureTime.UnixMilli(), fixtureTime.UnixMilli()); err != nil {
		t.Fatal(err)
	}
}
