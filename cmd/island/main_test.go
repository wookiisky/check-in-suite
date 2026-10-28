package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestRunCommands verifies serving never silently initializes an unmigrated database.
func TestRunCommands(t *testing.T) {
	ctx := context.Background()
	for _, args := range [][]string{nil, {"unknown"}, {"serve", "extra"}} {
		if err := run(ctx, args); err == nil {
			t.Fatalf("invalid arguments accepted: %v", args)
		}
	}
	dir := t.TempDir()
	configuration := filepath.Join(dir, "app.yaml")
	database := filepath.Join(dir, "island.db")
	content := fmt.Sprintf("listen_address: 127.0.0.1:8080\ndatabase_path: %q\nmedia_directory: %q\ntemp_directory: %q\nsqlite_busy_timeout: 5s\nhttp_timeout: 10s\nffprobe_path: nonexistent-island-probe\nmedia_probe_timeout: 3s\n", database, filepath.Join(dir, "media"), filepath.Join(dir, "tmp"))
	if err := os.WriteFile(configuration, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, []string{"serve", "-config", configuration}); err == nil || !strings.Contains(err.Error(), "migrate") {
		t.Fatalf("serve must request migration: %v", err)
	}
	if err := run(ctx, []string{"migrate", "-config", configuration}); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(ctx, database, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.CheckSchema(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err := run(ctx, []string{"serve", "-config", configuration}); err == nil || !strings.Contains(err.Error(), "media probe") {
		t.Fatalf("missing dependency must prevent startup: %v", err)
	}
}

// TestServeShutdown verifies a cancellation releases the listening socket.
func TestServeShutdown(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	location, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		t.Fatal(err)
	}
	if err := serve(ctx, config.Config{ListenAddress: address, HTTPTimeout: time.Second, Location: location}, http.NotFoundHandler()); err != nil {
		t.Fatal(err)
	}
	reopened, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("listener was not closed: %v", err)
	}
	reopened.Close()
}
