package storage

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wookiisky/check-in-suite/migrations"
)

// TestInspectMissingAndEmpty proves inspection neither creates a database nor initializes schema.
func TestInspectMissingAndEmpty(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "missing", "database.db")
	status, err := Inspect(ctx, path, migrations.Files)
	if err != nil || status.State != "missing" || status.DatabasePath != path {
		t.Fatalf("missing: %+v %v", status, err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("inspection created parent: %v", err)
	}
	path = filepath.Join(t.TempDir(), "empty.db")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	status, err = Inspect(ctx, path, migrations.Files)
	if err != nil || status.State != "empty" {
		t.Fatalf("empty: %+v %v", status, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != 0 {
		t.Fatalf("inspection wrote empty database: %v", err)
	}
}

// TestInspectHistoryAndWAL verifies current WAL state and distinguishes safe migrations from incompatible history.
func TestInspectHistoryAndWAL(t *testing.T) {
	ctx := context.Background()
	path, db := inspectionDatabase(t)
	status, err := Inspect(ctx, path, migrations.Files)
	if err != nil || status.State != "current" || status.AccountExists || status.DemoComplete {
		t.Fatalf("current: %+v %v", status, err)
	}
	if _, err := db.Exec("PRAGMA wal_autocheckpoint=0"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO accounts(id,username,display_name,login_password_hash,management_password_hash,created_at,updated_at) VALUES(1,'user','name','hash','hash',0,0)"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Fatalf("WAL fixture missing: %v", err)
	}
	status, err = Inspect(ctx, path, migrations.Files)
	if err != nil || !status.AccountExists || status.DemoComplete {
		t.Fatalf("WAL account: %+v %v", status, err)
	}
	files := inspectionMigrations(t)
	files[fmt.Sprintf("%03d_extra.sql", len(files)+1)] = &fstest.MapFile{Data: []byte("CREATE TABLE extra(id INTEGER PRIMARY KEY) STRICT;")}
	status, err = Inspect(ctx, path, files)
	if err != nil || status.State != "pending" || status.Applied+1 != status.Expected {
		t.Fatalf("pending: %+v %v", status, err)
	}
	if _, err := db.Exec("UPDATE schema_migrations SET checksum='modified' WHERE version=1"); err != nil {
		t.Fatal(err)
	}
	status, err = Inspect(ctx, path, migrations.Files)
	if err != nil || status.State != "incompatible" {
		t.Fatalf("mismatch: %+v %v", status, err)
	}
}

// TestInspectNewerAndMissingStructure rejects a newer executable history and structurally incomplete databases.
func TestInspectNewerAndMissingStructure(t *testing.T) {
	t.Run("newer", func(t *testing.T) {
		path, db := inspectionDatabase(t)
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO schema_migrations VALUES(?,?,?,0)", count+1, fmt.Sprintf("%03d_future.sql", count+1), "future"); err != nil {
			t.Fatal(err)
		}
		status, err := Inspect(context.Background(), path, migrations.Files)
		if err != nil || status.State != "newer" {
			t.Fatalf("newer: %+v %v", status, err)
		}
	})
	t.Run("missing index", func(t *testing.T) {
		path, db := inspectionDatabase(t)
		if _, err := db.Exec("DROP INDEX purchases_permanent"); err != nil {
			t.Fatal(err)
		}
		status, err := Inspect(context.Background(), path, migrations.Files)
		if err != nil || status.State != "incompatible" {
			t.Fatalf("missing index: %+v %v", status, err)
		}
	})
	t.Run("missing table", func(t *testing.T) {
		path, db := inspectionDatabase(t)
		if _, err := db.Exec("DROP TABLE messages"); err != nil {
			t.Fatal(err)
		}
		status, err := Inspect(context.Background(), path, migrations.Files)
		if err != nil || status.State != "incompatible" {
			t.Fatalf("missing table: %+v %v", status, err)
		}
	})
}

// TestInspectRejectsFaults keeps unreadable or corrupt inputs out of reset suggestions.
func TestInspectRejectsFaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.db")
	if err := os.WriteFile(path, []byte("not a SQLite database"), 0600); err != nil {
		t.Fatal(err)
	}
	if status, err := Inspect(context.Background(), path, migrations.Files); err == nil {
		t.Fatalf("corruption accepted: %+v", status)
	}
	if status, err := Inspect(context.Background(), t.TempDir(), migrations.Files); err == nil {
		t.Fatalf("directory accepted: %+v", status)
	}
}

// TestInspectUntrackedSchema reports existing application tables without migration history as incompatible.
func TestInspectUntrackedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := Open(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE old_data(id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	status, err := Inspect(context.Background(), path, migrations.Files)
	if err != nil || status.State != "incompatible" {
		t.Fatalf("untracked: %+v %v", status, err)
	}
}

// inspectionDatabase creates a real migrated database and retains its connection for WAL tests.
func inspectionDatabase(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "database.db")
	db, err := Open(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	return path, db
}

// inspectionMigrations copies embedded migrations so a test can append a real next version.
func inspectionMigrations(t *testing.T) fstest.MapFS {
	t.Helper()
	names, err := fs.Glob(migrations.Files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	result := fstest.MapFS{}
	for _, name := range names {
		data, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		result[name] = &fstest.MapFile{Data: data}
	}
	return result
}

// TestInspectSeedCompletion observes only a committed marker for the supported seed version.
func TestInspectSeedCompletion(t *testing.T) {
	path, db := inspectionDatabase(t)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO demo_seeds(version,completed_at) VALUES(1,0)"); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	status, err := Inspect(ctx, path, migrations.Files)
	if err != nil || status.DemoComplete {
		tx.Rollback()
		t.Fatalf("uncommitted marker: %+v %v", status, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	status, err = Inspect(ctx, path, migrations.Files)
	if err != nil || !status.DemoComplete {
		t.Fatalf("committed marker: %+v %v", status, err)
	}
	if _, err := db.Exec("UPDATE demo_seeds SET version=2"); err != nil {
		t.Fatal(err)
	}
	status, err = Inspect(ctx, path, migrations.Files)
	if err != nil || status.DemoComplete {
		t.Fatalf("unsupported marker: %+v %v", status, err)
	}
}

// TestInspectReadOnlyConnection leaves migration history and existing database bytes unchanged.
func TestInspectReadOnlyConnection(t *testing.T) {
	path, db := inspectionDatabase(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		status, err := Inspect(context.Background(), path, migrations.Files)
		if err != nil || status.State != "current" {
			t.Fatalf("read-only: %+v %v", status, err)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("inspection changed database bytes")
	}
}

// TestInspectLegacyHistoryFormat recognizes incompatible history without matching driver error text.
func TestInspectLegacyHistoryFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-history.db")
	db, err := Open(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	status, err := Inspect(context.Background(), path, migrations.Files)
	if err != nil || status.State != "incompatible" || status.Reason != "migration_history_format" {
		t.Fatalf("legacy history: %+v %v", status, err)
	}
}
