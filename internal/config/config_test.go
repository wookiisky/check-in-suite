package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestLoad verifies configuration parsing and rejects ambiguous startup settings.
func TestLoad(t *testing.T) {
	valid := "listen_address: 127.0.0.1:8080\ndatabase_path: .local/island.db\nmedia_directory: .local/media\ntemp_directory: .local/tmp\nsqlite_busy_timeout: 5s\nhttp_timeout: 10s\nffprobe_path: ffprobe\nmedia_probe_timeout: 3s\n"
	for _, tc := range []struct {
		name      string // Test case description.
		input     string // YAML configuration under test.
		wantError bool   // Whether startup must reject this configuration.
	}{
		{"valid", valid, false},
		{"unknown field", valid + "timezone: UTC\n", true},
		{"missing path", strings.ReplaceAll(valid, "database_path: .local/island.db\n", ""), true},
		{"invalid duration", strings.ReplaceAll(valid, "5s", "tomorrow"), true},
		{"zero timeout", strings.ReplaceAll(valid, "5s", "0s"), true},
		{"request shorter than lock", strings.ReplaceAll(valid, "10s", "4s"), true},
		{"invalid address", strings.ReplaceAll(valid, "127.0.0.1:8080", "localhost"), true},
		{"multiple documents", valid + "---\n" + valid, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "app.yaml")
			if err := os.WriteFile(path, []byte(tc.input), 0600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if (err != nil) != tc.wantError {
				t.Fatalf("Load error = %v, wantError = %v", err, tc.wantError)
			}
			if err == nil && (cfg.SQLiteBusyTimeout != 5*time.Second || cfg.Location.String() != "Asia/Taipei") {
				t.Fatalf("unexpected config: %+v", cfg)
			}
		})
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("missing file accepted")
	}
}
