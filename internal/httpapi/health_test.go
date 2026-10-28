package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestHealth verifies actual serialized status, HTTP methods, and dependency failures.
func TestHealth(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "health.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	probe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ISLAND_TEST_PROBE_MODE", "success")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	ready := &Readiness{DB: db, FFprobePath: probe, ProbeTimeout: time.Second}
	handler := NewHandler(ready, 2*time.Second)
	for _, tc := range []struct {
		method string // HTTP method under test.
		path   string // Health or unknown route.
		code   int    // Expected response status.
	}{
		{http.MethodGet, "/health/live", 200},
		{http.MethodGet, "/health/ready", 200},
		{http.MethodPost, "/health/live", 405},
		{http.MethodGet, "/missing", 404},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, nil))
		if recorder.Code != tc.code {
			t.Fatalf("%s %s = %d, want %d", tc.method, tc.path, recorder.Code, tc.code)
		}
		if tc.code == 200 {
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || len(body) != 1 || body["status"] != "ok" {
				t.Fatalf("unexpected health body: %s (%v)", recorder.Body, err)
			}
			if recorder.Header().Get("Content-Type") != "application/json" {
				t.Fatal("missing JSON content type")
			}
		}
	}
	for _, mode := range []string{"failure", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ISLAND_TEST_PROBE_MODE", mode)
			ready.ProbeTimeout = 25 * time.Millisecond
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
			if recorder.Code != 503 || recorder.Body.String() != "{\"status\":\"unavailable\"}\n" {
				t.Fatalf("dependency failure response: %d %s", recorder.Code, recorder.Body)
			}
		})
	}
	ready.FFprobePath = filepath.Join(t.TempDir(), "missing-probe")
	if err := ready.Check(ctx); err == nil {
		t.Fatal("missing executable accepted")
	}
	ready.FFprobePath = probe
	if _, err := db.ExecContext(ctx, "UPDATE schema_migrations SET checksum = 'changed'"); err != nil {
		t.Fatal(err)
	}
	if err := ready.Check(ctx); err == nil {
		t.Fatal("changed migration accepted by readiness")
	}
	db.Close()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if recorder.Code != 503 {
		t.Fatal("closed database ready")
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/live", nil))
	if recorder.Code != 200 {
		t.Fatal("liveness must be independent of database readiness")
	}
}
