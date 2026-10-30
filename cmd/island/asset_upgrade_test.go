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
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/demo"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestDemoCLIWithHistoricalBadge verifies deployment initialization preserves either published v1 name.
func TestDemoCLIWithHistoricalBadge(t *testing.T) {
	fixture := filepath.Join("..", "..", "internal", "assets", "testdata", "explorer-v1")
	metadata, err := os.ReadFile(filepath.Join(fixture, "metadata.json"))
	if err != nil {
		t.Fatal(err)
	}
	drawing, err := os.ReadFile(filepath.Join(fixture, "asset.svg"))
	if err != nil {
		t.Fatal(err)
	}
	var historical assets.Asset
	if err := json.Unmarshal(metadata, &historical); err != nil {
		t.Fatal(err)
	}
	for _, release := range []struct {
		name      string // Release whose persistent metadata is being retained.
		assetName string // Name written by that release under the v1 identity.
	}{
		{name: "old-release", assetName: historical.Name},
		{name: "failed-release", assetName: "探索营地"},
	} {
		t.Run(release.name, func(t *testing.T) {
			ctx := context.Background()
			configuration, database := deploymentConfig(t)
			cfg, err := config.Load(configuration)
			if err != nil {
				t.Fatal(err)
			}
			retained := historical
			retained.Name = release.assetName
			retainedMetadata, err := json.Marshal(retained)
			if err != nil {
				t.Fatal(err)
			}
			legacyDirectory := filepath.Join(cfg.AssetsDirectory, retained.Key)
			if err := os.MkdirAll(legacyDirectory, 0700); err != nil {
				t.Fatal(err)
			}
			for name, body := range map[string][]byte{"metadata.json": retainedMetadata, "asset.svg": drawing} {
				if err := os.WriteFile(filepath.Join(legacyDirectory, name), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			if err := runWithIO(ctx, []string{"migrate", "-config", configuration}, strings.NewReader(""), &output); err != nil {
				t.Fatalf("migrate: %v", err)
			}
			for attempt := range 2 {
				output.Reset()
				if err := runWithIO(ctx, []string{"seed-demo", "-config", configuration}, strings.NewReader(""), &output); err != nil {
					t.Fatalf("seed attempt %d: %v", attempt+1, err)
				}
				var result demo.Result
				if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.Skipped != (attempt == 1) {
					t.Fatalf("seed attempt %d: result=%s error=%v", attempt+1, output.String(), err)
				}
			}
			status, err := storage.Inspect(ctx, database, migrations.Files)
			if err != nil || status.State != "current" || !status.AccountExists || !status.DemoComplete {
				t.Fatalf("status=%+v error=%v", status, err)
			}
			db, err := storage.Open(ctx, database, cfg.SQLiteBusyTimeout)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, _, err := account.New(db, cfg).Login(ctx, "user", "pass"); err != nil {
				t.Fatalf("demo login failed: %v", err)
			}
			for name, expected := range map[string][]byte{"metadata.json": retainedMetadata, "asset.svg": drawing} {
				actual, err := os.ReadFile(filepath.Join(legacyDirectory, name))
				if err != nil || !bytes.Equal(actual, expected) {
					t.Fatalf("historical %s changed: %v", name, err)
				}
			}
			current, exists := assets.Get("badge-explorer-v2")
			if !exists {
				t.Fatal("current explorer badge is missing from the catalog")
			}
			installed, err := assets.New(cfg.AssetsDirectory).Lookup(current.Key)
			if err != nil || installed != current {
				t.Fatalf("current badge not installed: asset=%+v error=%v", installed, err)
			}
		})
	}
}
