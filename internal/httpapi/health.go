// Package httpapi adapts application dependencies to HTTP routes.
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// Readiness checks only dependencies needed by the current server skeleton.
type Readiness struct {
	DB           *sql.DB       // The application's single-connection database pool.
	FFprobePath  string        // Audio-probe executable, resolved by exec without a shell.
	ProbeTimeout time.Duration // Maximum lifetime of the dependency probe process.
}

// Check verifies database access, migration identity, and the media probe executable.
func (ready *Readiness) Check(ctx context.Context) error {
	if err := storage.CheckSchema(ctx, ready.DB, migrations.Files); err != nil {
		return fmt.Errorf("database readiness: %w", err)
	}
	probeContext, cancel := context.WithTimeout(ctx, ready.ProbeTimeout)
	defer cancel()
	if err := exec.CommandContext(probeContext, ready.FFprobePath, "-version").Run(); err != nil {
		return fmt.Errorf("media probe readiness: %w", err)
	}
	return nil
}

// healthResponse exposes protocol status only, never internal paths or dependency errors.
type healthResponse struct {
	Status string `json:"status"` // OpenAPI status enum: ok or unavailable.
}

// NewHandler registers method-aware health routes with bounded dependency checks.
func NewHandler(ready *Readiness, timeout time.Duration) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		writeHealth(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		if err := ready.Check(ctx); err != nil {
			slog.WarnContext(ctx, "服务就绪检查失败", "error", err)
			writeHealth(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeHealth(w, http.StatusOK, "ok")
	})
	return mux
}

// writeHealth writes a small fixed JSON response without leaking diagnostic details.
func writeHealth(w http.ResponseWriter, code int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(healthResponse{Status: status}); err != nil {
		slog.Debug("健康响应写入失败", "error", err)
	}
}
