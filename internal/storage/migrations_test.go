package storage

import (
	"context"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wookiisky/check-in-suite/migrations"
)

// TestMigrate verifies initialization, repeat execution, and immutable migration history.
func TestMigrate(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "migration.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := CheckSchema(ctx, db, migrations.Files); err == nil {
		t.Fatal("uninitialized schema accepted")
	}
	for i := 0; i < 2; i++ {
		if err := Migrate(ctx, db, migrations.Files); err != nil {
			t.Fatal(err)
		}
		if err := CheckSchema(ctx, db, migrations.Files); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&count); err != nil || count != 1 {
		t.Fatalf("migration count = %d: %v", count, err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE schema_migrations SET checksum = 'changed'"); err != nil {
		t.Fatal(err)
	}
	if err := CheckSchema(ctx, db, migrations.Files); err == nil {
		t.Fatal("checksum mismatch accepted")
	}
	if err := Migrate(ctx, db, migrations.Files); err == nil {
		t.Fatal("migration overwrote changed history")
	}
}

// TestMigrationRollback proves failing SQL leaves neither schema changes nor history.
func TestMigrationRollback(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "rollback.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	initial, err := fs.ReadFile(migrations.Files, "001_schema_migrations.sql")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{
		"001_schema_migrations.sql": {Data: initial},
		"002_failure.sql":           {Data: []byte("CREATE TABLE transient (id INTEGER) STRICT; THIS IS INVALID;")},
	}
	if err := CheckSchema(ctx, db, files); err == nil {
		t.Fatal("pending migration accepted")
	}
	if err := Migrate(ctx, db, files); err == nil {
		t.Fatal("invalid migration succeeded")
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'transient'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial schema remains: %d %v", count, err)
	}
	if err := CheckSchema(ctx, db, migrations.Files); err != nil {
		t.Fatalf("previous schema damaged: %v", err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO schema_migrations VALUES (2, '002_future.sql', 'future', 0)"); err != nil {
		t.Fatal(err)
	}
	if err := CheckSchema(ctx, db, migrations.Files); err == nil {
		t.Fatal("future migration accepted")
	}
}
