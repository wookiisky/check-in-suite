package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// TestOpen verifies persistent WAL and connection-specific settings after replacement.
func TestOpen(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "space ? #.db"), 80*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if db.Stats().MaxOpenConnections != 1 {
		t.Fatal("connection pool must have one connection")
	}
	for i := 0; i < 2; i++ {
		for pragma, want := range map[string]int{"foreign_keys": 1, "busy_timeout": 80, "synchronous": 2} {
			var got int
			if err := db.QueryRowContext(ctx, "PRAGMA "+pragma).Scan(&got); err != nil || got != want {
				t.Fatalf("%s = %d, want %d: %v", pragma, got, want, err)
			}
		}
		var mode string
		if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
			t.Fatalf("journal mode = %q: %v", mode, err)
		}
		db.SetMaxIdleConns(0)
		db.SetMaxIdleConns(1)
	}
}

// TestTransactionModes proves locking and snapshot semantics across separate pools.
func TestTransactionModes(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "locking.db")
	first, err := Open(ctx, path, 30*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(ctx, path, 30*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := first.ExecContext(ctx, "CREATE TABLE sample (value INTEGER NOT NULL) STRICT; INSERT INTO sample VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	reader, err := first.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback()
	var value int
	if err := reader.QueryRowContext(ctx, "SELECT value FROM sample").Scan(&value); err != nil || value != 1 {
		t.Fatalf("initial snapshot: %d %v", value, err)
	}
	writer, err := second.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("read transaction acquired a write lock: %v", err)
	}
	if _, err := writer.ExecContext(ctx, "UPDATE sample SET value = 2"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := reader.QueryRowContext(ctx, "SELECT value FROM sample").Scan(&value); err != nil || value != 1 {
		t.Fatalf("snapshot changed: %d %v", value, err)
	}
	if err := reader.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := first.QueryRowContext(ctx, "SELECT value FROM sample").Scan(&value); err != nil || value != 2 {
		t.Fatalf("committed value: %d %v", value, err)
	}
	locked, err := first.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback()
	if competing, err := second.BeginTx(ctx, nil); err == nil {
		competing.Rollback()
		t.Fatal("write transaction did not acquire IMMEDIATE lock")
	}
	if err := locked.Rollback(); err != nil {
		t.Fatal(err)
	}
	recovered, err := second.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	recovered.Rollback()
}
