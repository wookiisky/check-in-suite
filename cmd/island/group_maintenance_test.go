package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestGroupMaintenanceCommands proves account creation, group creation and targeted recovery through the CLI.
func TestGroupMaintenanceCommands(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	configuration := filepath.Join(dir, "app.yaml")
	database := filepath.Join(dir, "island.db")
	yaml := fmt.Sprintf("listen_address: 127.0.0.1:8080\ndatabase_path: %q\nmedia_directory: %q\ntemp_directory: %q\nsqlite_busy_timeout: 5s\nhttp_timeout: 30s\nffprobe_path: ffprobe\nmedia_probe_timeout: 3s\n", database, filepath.Join(dir, "media"), filepath.Join(dir, "tmp"))
	if err := os.WriteFile(configuration, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	command := func(name, input string, extra ...string) error {
		args := append([]string{name, "-config", configuration}, extra...)
		return runWithIO(ctx, args, strings.NewReader(input), &output)
	}
	if err := command("migrate", ""); err != nil {
		t.Fatal(err)
	}
	for _, username := range []string{"first", "second"} {
		input := username + "\n" + username + "\nlogin-password\nlogin-password\nmanage-password\nmanage-password\n"
		if err := command("init", input); err != nil {
			t.Fatalf("create %s: %v", username, err)
		}
	}
	db, err := storage.Open(ctx, database, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var accounts, owners int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM accounts").Scan(&accounts); err != nil || accounts != 2 {
		t.Fatalf("accounts=%d %v", accounts, err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(DISTINCT account_id) FROM products").Scan(&owners); err != nil || owners != 2 {
		t.Fatalf("catalog owners=%d %v", owners, err)
	}
	if err := command("create-group", "一起成长\n"); err != nil {
		t.Fatal(err)
	}
	if err := command("create-group", "一起成长\n"); err == nil {
		t.Fatal("duplicate group accepted")
	}
	if err := command("create-group", " \n"); err == nil {
		t.Fatal("empty group accepted")
	}
	var groups int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM groups").Scan(&groups); err != nil || groups != 1 {
		t.Fatalf("groups=%d %v", groups, err)
	}
	cfg, err := config.Load(configuration)
	if err != nil {
		t.Fatal(err)
	}
	service := account.New(db, cfg)
	first, _, err := service.Login(ctx, "first", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := service.Login(ctx, "second", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := command("reset-password", "new-password\nnew-password\n", "-kind", "login"); err == nil {
		t.Fatal("ambiguous password reset accepted")
	}
	if _, err := service.Authenticate(ctx, first); err != nil {
		t.Fatal("ambiguous reset changed first account")
	}
	if err := command("reset-password", "new-password\nnew-password\n", "-username", "first", "-kind", "login"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Authenticate(ctx, first); err == nil {
		t.Fatal("target account kept old session")
	}
	if _, err := service.Authenticate(ctx, second); err != nil {
		t.Fatalf("other account session revoked: %v", err)
	}
	if _, _, err := service.Login(ctx, "first", "new-password"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "login-password") || strings.Contains(output.String(), "manage-password") || strings.Contains(output.String(), "new-password") {
		t.Fatal("password echoed")
	}
}
