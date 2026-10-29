package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// deploymentConfig isolates CLI data and installed artwork from daily development files.
func deploymentConfig(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	database := filepath.Join(directory, "data", "island.db")
	configuration := filepath.Join(directory, "app.yaml")
	source := fmt.Sprintf("listen_address: 0.0.0.0:8080\ndatabase_path: %q\nmedia_directory: %q\ntemp_directory: %q\nassets_directory: %q\nsqlite_busy_timeout: 5s\nhttp_timeout: 10s\nffprobe_path: ffprobe\nmedia_probe_timeout: 3s\n", database, filepath.Join(directory, "media"), filepath.Join(directory, "tmp"), filepath.Join(directory, "assets"))
	if err := os.WriteFile(configuration, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	return configuration, database
}

// TestDatabaseStatusCLI verifies machine output and proves inspection never creates missing data.
func TestDatabaseStatusCLI(t *testing.T) {
	configuration, database := deploymentConfig(t)
	var output bytes.Buffer
	if err := runWithIO(context.Background(), []string{"db-status", "-config", configuration}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	var status struct {
		State     string `json:"state"`
		HealthURL string `json:"health_url"`
	}
	if err := json.Unmarshal(output.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.State != "missing" || status.HealthURL != "http://127.0.0.1:8080" {
		t.Fatalf("unexpected status %+v", status)
	}
	if _, err := os.Stat(filepath.Dir(database)); !os.IsNotExist(err) {
		t.Fatalf("status created data directory: %v", err)
	}
	output.Reset()
	if err := runWithIO(context.Background(), []string{"db-status", "-config", configuration, "-format", "tsv"}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	fields := strings.Split(strings.TrimSuffix(output.String(), "\n"), "\t")
	if len(fields) != 10 || fields[0] != "missing" || fields[1] != database || fields[4] != "http://127.0.0.1:8080" {
		t.Fatalf("invalid publish protocol: %q", output.String())
	}
	if err := runWithIO(context.Background(), []string{"db-status", "-config", configuration, "-format", "unknown"}, strings.NewReader(""), &output); err == nil {
		t.Fatal("unknown output format accepted")
	}
}

// TestDemoCLI verifies the deployed command creates usable credentials under unchanged formal limits.
func TestDemoCLI(t *testing.T) {
	configuration, database := deploymentConfig(t)
	ctx := context.Background()
	var output bytes.Buffer
	for _, command := range []string{"migrate", "seed-demo", "seed-demo"} {
		output.Reset()
		if err := runWithIO(ctx, []string{command, "-config", configuration}, strings.NewReader(""), &output); err != nil {
			t.Fatalf("%s: %v", command, err)
		}
	}
	var result struct {
		Skipped bool `json:"skipped"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || !result.Skipped {
		t.Fatalf("seed repeat result=%s error=%v", output.String(), err)
	}
	cfg, err := config.Load(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Limits.PasswordMin != 10 {
		t.Fatal("formal password limit changed")
	}
	db, err := storage.Open(ctx, database, cfg.SQLiteBusyTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	accounts := account.New(db, cfg)
	token, _, err := accounts.Login(ctx, "user", "pass")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := accounts.Unlock(ctx, principal, "pass"); err != nil {
		t.Fatal(err)
	}
}

// TestIPv6DatabaseStatus uses the IPv6 loopback when the service listens only on IPv6.
func TestIPv6DatabaseStatus(t *testing.T) {
	configuration, _ := deploymentConfig(t)
	source, err := os.ReadFile(configuration)
	if err != nil {
		t.Fatal(err)
	}
	source = bytes.ReplaceAll(source, []byte("0.0.0.0:8080"), []byte("'[::]:8080'"))
	if err := os.WriteFile(configuration, source, 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runWithIO(context.Background(), []string{"db-status", "-config", configuration}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		HealthURL string `json:"health_url"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.HealthURL != "http://[::1]:8080" {
		t.Fatalf("health endpoint=%s", result.HealthURL)
	}
}
