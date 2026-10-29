package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/demo"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestResetDemoCLI proves rebuilding replaces existing data and produces a usable current database.
func TestResetDemoCLI(t *testing.T) {
	for _, initial := range []string{"missing", "incompatible", "current"} {
		t.Run(initial, func(t *testing.T) {
			ctx := context.Background()
			configuration, database := deploymentConfig(t)
			cfg, err := config.Load(configuration)
			if err != nil {
				t.Fatal(err)
			}
			for _, directory := range []string{cfg.MediaDirectory, cfg.TempDirectory, cfg.AssetsDirectory} {
				if err := os.MkdirAll(directory, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(directory, "keep.txt"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if initial != "missing" {
				if err := run(ctx, []string{"migrate", "-config", configuration}); err != nil {
					t.Fatal(err)
				}
				db, err := storage.Open(ctx, database, cfg.SQLiteBusyTimeout)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(`CREATE TABLE reset_marker (value TEXT); INSERT INTO reset_marker VALUES ('old data')`); err != nil {
					t.Fatal(err)
				}
				if initial == "incompatible" {
					if _, err := db.Exec(`UPDATE schema_migrations SET checksum='old checksum' WHERE version=2; ALTER TABLE accounts DROP COLUMN base_avatar_key`); err != nil {
						t.Fatal(err)
					}
					if err := storage.CheckSchema(ctx, db, migrations.Files); err == nil {
						t.Fatal("incompatible fixture passed schema validation")
					}
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
			}
			rounds := 1
			if initial == "current" {
				rounds = 2
			}
			for range rounds {
				// Leftover sidecars belong to closed connections and must not be reused.
				if err := os.MkdirAll(filepath.Dir(database), 0700); err != nil {
					t.Fatal(err)
				}
				for _, suffix := range []string{"-wal", "-shm"} {
					if err := os.WriteFile(database+suffix, []byte("stale sidecar"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				var output bytes.Buffer
				if err := runWithIO(ctx, []string{"reset-demo", "-config", configuration}, strings.NewReader(""), &output); err != nil {
					t.Fatal(err)
				}
				var result demo.Result
				if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.Skipped || result.Tasks == 0 || result.Checkins == 0 || result.Purchases == 0 {
					t.Fatalf("reset result=%s error=%v", output.String(), err)
				}
				status, err := storage.Inspect(ctx, database, migrations.Files)
				if err != nil || status.State != "current" || !status.AccountExists || !status.DemoComplete {
					t.Fatalf("status=%+v error=%v", status, err)
				}
				db, err := storage.Open(ctx, database, cfg.SQLiteBusyTimeout)
				if err != nil {
					t.Fatal(err)
				}
				var leftovers int
				if err := db.QueryRow(`SELECT (SELECT count(*) FROM sqlite_master WHERE name='reset_marker') + (SELECT count(*) FROM messages WHERE id='reset-marker')`).Scan(&leftovers); err != nil || leftovers != 0 {
					t.Fatalf("old data survived reset: count=%d error=%v", leftovers, err)
				}
				if _, _, err := account.New(db, cfg).Login(ctx, "user", "pass"); err != nil {
					t.Fatalf("demo login failed: %v", err)
				}
				if _, err := db.Exec(`INSERT INTO messages(id,text,created_at) VALUES('reset-marker','discard on next reset',1)`); err != nil {
					t.Fatal(err)
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
				for _, suffix := range []string{"-wal", "-shm"} {
					data, err := os.ReadFile(database + suffix)
					if err != nil && !os.IsNotExist(err) {
						t.Fatal(err)
					}
					if bytes.Equal(data, []byte("stale sidecar")) {
						t.Fatalf("stale %s survived reset", suffix)
					}
				}
			}
			for _, directory := range []string{cfg.MediaDirectory, cfg.TempDirectory, cfg.AssetsDirectory} {
				data, err := os.ReadFile(filepath.Join(directory, "keep.txt"))
				if err != nil || string(data) != "keep" {
					t.Fatalf("unrelated files changed: directory=%s error=%v", directory, err)
				}
			}
		})
	}
}

// TestResetDemoDeletionFailure stops before initialization when a target cannot be removed.
func TestResetDemoDeletionFailure(t *testing.T) {
	configuration, database := deploymentConfig(t)
	if err := os.MkdirAll(database, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(database, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err := runWithIO(context.Background(), []string{"reset-demo", "-config", configuration}, strings.NewReader(""), &output)
	if err == nil || !strings.Contains(err.Error(), "remove database file") || output.Len() != 0 {
		t.Fatalf("deletion failure: output=%q error=%v", output.String(), err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("directory contents changed: %v", err)
	}
}

// TestResetDemoSeedFailure returns the initialization error without reporting completion.
func TestResetDemoSeedFailure(t *testing.T) {
	configuration, database := deploymentConfig(t)
	cfg, err := config.Load(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.AssetsDirectory, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runWithIO(context.Background(), []string{"reset-demo", "-config", configuration}, strings.NewReader(""), &output); err == nil || output.Len() != 0 {
		t.Fatalf("seed failure: output=%q error=%v", output.String(), err)
	}
	status, err := storage.Inspect(context.Background(), database, migrations.Files)
	if err != nil || status.State != "current" || status.AccountExists || status.DemoComplete {
		t.Fatalf("failed seed status=%+v error=%v", status, err)
	}
}
