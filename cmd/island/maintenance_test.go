package main

import (
	"bufio"
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

// TestMaintenanceCommands proves pipe input, persistence and revocation through the real CLI path.
func TestMaintenanceCommands(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	configuration := filepath.Join(dir, "app.yaml")
	database := filepath.Join(dir, "island.db")
	yaml := fmt.Sprintf("listen_address: 127.0.0.1:8080\ndatabase_path: %q\nmedia_directory: %q\ntemp_directory: %q\nsqlite_busy_timeout: 5s\nhttp_timeout: 10s\nffprobe_path: ffprobe\nmedia_probe_timeout: 3s\n", database, filepath.Join(dir, "media"), filepath.Join(dir, "tmp"))
	if err := os.WriteFile(configuration, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runWithIO(ctx, []string{"migrate", "-config", configuration}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	input := "family\n小岛\nlogin-password\nlogin-password\nmanage-password\nmanage-password\n"
	if err := runWithIO(ctx, []string{"init", "-config", configuration}, strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "login-password") || strings.Contains(output.String(), "manage-password") {
		t.Fatal("password echoed to output")
	}
	if err := runWithIO(ctx, []string{"init", "-config", configuration}, strings.NewReader(input), &output); err == nil {
		t.Fatal("duplicate initialization accepted")
	}
	db, err := storage.Open(ctx, database, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg, err := config.Load(configuration)
	if err != nil {
		t.Fatal(err)
	}
	service := account.New(db, cfg)
	token, _, err := service.Login(ctx, "family", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := runWithIO(ctx, []string{"reset-password", "-config", configuration, "-kind", "login"}, strings.NewReader("new-password\nnew-password\n"), &output); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Authenticate(ctx, token); err == nil {
		t.Fatal("password reset preserved old session")
	}
	if _, _, err := service.Login(ctx, "family", "new-password"); err != nil {
		t.Fatal(err)
	}
	if err := runWithIO(ctx, []string{"reset-password", "-config", configuration, "-kind", "unknown"}, strings.NewReader(""), &output); err == nil {
		t.Fatal("unknown password kind accepted")
	}
	if err := runWithIO(ctx, []string{"init", "-config", configuration, "--password", "secret"}, strings.NewReader(""), &output); err == nil {
		t.Fatal("password command argument accepted")
	}
}

// TestPasswordPromptFailure stops before any database mutation when confirmation is missing or different.
func TestPasswordPromptFailure(t *testing.T) {
	for _, value := range []string{"first\nsecond\n", "first\n"} {
		var output bytes.Buffer
		input := terminalInput{Reader: bufio.NewReader(strings.NewReader(value)), Output: &output}
		if _, err := input.password("new_password_prompt"); err == nil {
			t.Fatal("invalid confirmation accepted")
		}
		if strings.Contains(output.String(), "first") || strings.Contains(output.String(), "second") {
			t.Fatal("password value appeared in output")
		}
	}
}
