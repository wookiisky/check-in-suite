package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestLoadStorageSeparation rejects shared cleanup directories through normalized and symlink paths.
func TestLoadStorageSeparation(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	data := filepath.Join(root, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "island.db"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(data, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(data, "island.db"), filepath.Join(root, "database-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("new", filepath.Join(data, "missing-alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(data, "new.db"), filepath.Join(root, "new-database-link")); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string // Storage relationship under test.
		database  string // SQLite file path.
		media     string // Directory scanned for media orphans.
		temporary string // Directory scanned for temporary orphans.
		wantError bool   // Whether configuration must refuse this relationship.
	}{
		{"media shared", "data/island.db", data, "tmp", true},
		{"temporary shared", "data/island.db", "media", "data", true},
		{"normalized shared", "data/island.db", "data/../data/.", "tmp", true},
		{"media alias", "data/island.db", "alias", "tmp", true},
		{"temporary alias", "data/island.db", "media", "alias", true},
		{"database file alias", "database-link", "data", "tmp", true},
		{"missing shared directory", "new/data/island.db", "new/data", "tmp", true},
		{"alias missing child", "data/new/island.db", "alias/new", "tmp", true},
		{"missing directory alias", "data/new/island.db", "data/missing-alias", "tmp", true},
		{"missing database file alias", "new-database-link", "data", "tmp", true},
		{"new separated directories", "new/data/island.db", "new/media", "new/tmp", false},
		{"nested media directory", "data/island.db", "data/media", "data/tmp", false},
		{"nested database directory", "data/new/island.db", "data", "tmp", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := fmt.Sprintf("listen_address: 127.0.0.1:8080\ndatabase_path: %q\nmedia_directory: %q\ntemp_directory: %q\nsqlite_busy_timeout: 5s\nhttp_timeout: 10s\nffprobe_path: ffprobe\nmedia_probe_timeout: 3s\n", tc.database, tc.media, tc.temporary)
			path := filepath.Join(root, "app.yaml")
			if err := os.WriteFile(path, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); (err != nil) != tc.wantError {
				t.Fatalf("Load error=%v, wantError=%v", err, tc.wantError)
			}
		})
	}
}
