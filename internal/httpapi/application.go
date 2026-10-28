package httpapi

import (
	"bufio"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
)

const sessionCookieName = "island_session"

// App connects the shared HTTP boundary to the account and feature services.
type App struct {
	DB       *sql.DB                   // Shared single-connection application database.
	Config   config.Config             // Validated deployment configuration.
	Accounts *account.Service          // Session and credential authority.
	Now      func() time.Time          // Clock used by HTTP rate limiting.
	Mux      *http.ServeMux            // Explicit feature route registry.
	mu       sync.Mutex                // Protects the short-lived source attempt window.
	attempts map[string]sourceAttempts // Attempts keyed only by direct peer address.
}

// sourceAttempts bounds password work from one source during a fixed interval.
type sourceAttempts struct {
	Count int       // Requests admitted in this interval.
	Until time.Time // Time at which this interval expires.
}

// NewApplication registers account routes alongside existing health endpoints.
func NewApplication(ready *Readiness, cfg config.Config, accounts *account.Service) *App {
	app := &App{DB: accounts.DB, Config: cfg, Accounts: accounts, Now: time.Now, Mux: http.NewServeMux(), attempts: make(map[string]sourceAttempts)}
	app.Mux.Handle("/health/", NewHandler(ready, cfg.HTTPTimeout))
	app.registerAccounts()
	app.Mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, &core.Error{Status: 404, Code: "NOT_FOUND"})
	})
	app.Mux.HandleFunc("/", app.static)
	return app
}

// ServeHTTP gives every response an independently generated request identity.
func (app *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	budget := app.Config.HTTPTimeout
	if r.Method == http.MethodPost && r.URL.Path == "/api/v1/media" {
		budget = app.Config.UploadTimeout
	}
	if budget > 0 {
		deadline := time.Now().Add(budget)
		ctx, cancel := context.WithDeadline(r.Context(), deadline)
		defer cancel()
		r = r.WithContext(ctx)
		// Socket deadlines also interrupt stalled bodies; recorder-based tests have no socket.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(deadline)
		_ = controller.SetWriteDeadline(deadline)
	}
	requestID := uuid.NewString()
	w.Header().Set("X-Request-ID", requestID)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	start := time.Now()
	app.Mux.ServeHTTP(w, r)
	slog.DebugContext(r.Context(), "请求处理完成", "request_id", requestID, "method", r.Method, "duration_ms", time.Since(start).Milliseconds())
}

// Authenticate reads only the opaque cookie; credentials never come from URL parameters.
func (app *App) Authenticate(r *http.Request) (account.Principal, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return account.Principal{}, &core.Error{Status: 401, Code: "SESSION_REQUIRED"}
	}
	return app.Accounts.Authenticate(r.Context(), cookie.Value)
}

// MutationGuard checks both the configured origin and the session-bound CSRF value.
func (app *App) MutationGuard(r *http.Request, principal account.Principal) error {
	if err := app.originGuard(r); err != nil {
		return err
	}
	csrf := r.Header.Get("X-CSRF-Token")
	if csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(principal.CSRFToken)) != 1 {
		return &core.Error{Status: 403, Code: "CSRF_INVALID"}
	}
	return nil
}

// originGuard does not trust forwarded host headers to expand the allowed origin.
func (app *App) originGuard(r *http.Request) error {
	if r.Header.Get("Origin") != app.Config.PublicOrigin {
		return &core.Error{Status: 403, Code: "ORIGIN_INVALID"}
	}
	return nil
}

// DecodeJSON accepts one bounded JSON object and rejects unknown business fields.
func DecodeJSON(w http.ResponseWriter, r *http.Request, destination any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	reader := bufio.NewReader(r.Body)
	for {
		first, err := reader.ReadByte()
		if err != nil {
			return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
		}
		if first == ' ' || first == '\t' || first == '\r' || first == '\n' {
			continue
		}
		if first != '{' {
			return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
		}
		if err := reader.UnreadByte(); err != nil {
			return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
		}
		break
	}
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return &core.Error{Status: 400, Code: "INVALID_REQUEST"}
	}
	return nil
}

// WriteJSON emits successful protocol data without encoding internal errors.
func WriteJSON(w http.ResponseWriter, status int, value any) {
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Debug("响应写入失败", "error", err)
	}
}

// WriteError translates internal failures into stable codes with no SQL or paths.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	status, code := http.StatusInternalServerError, "INTERNAL_ERROR"
	fields := map[string]string{}
	var version *int64
	var domainError *core.Error
	if errors.As(err, &domainError) {
		status, code, version = domainError.Status, domainError.Code, domainError.CurrentVersion
		if domainError.FieldErrors != nil {
			fields = domainError.FieldErrors
		}
	} else {
		var sqliteError interface{ Code() int }
		if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
			status, code = 503, "STORAGE_UNAVAILABLE"
		} else if errors.As(err, &sqliteError) {
			switch sqliteError.Code() & 255 {
			case 5, 6:
				status, code = 503, "DATABASE_BUSY"
			case 10, 13, 14:
				status, code = 503, "STORAGE_UNAVAILABLE"
			}
		}
		slog.ErrorContext(r.Context(), "请求处理失败", "request_id", w.Header().Get("X-Request-ID"), "error", err)
	}
	if status == 429 {
		w.Header().Set("Retry-After", "60")
	}
	WriteJSON(w, status, struct {
		Code           string            `json:"code"`                      // Stable public error identifier.
		FieldErrors    map[string]string `json:"field_errors"`              // Resource keys for field feedback.
		RequestID      string            `json:"request_id"`                // Correlation identity, never a session token.
		CurrentVersion *int64            `json:"current_version,omitempty"` // Conflicting current entity version.
	}{code, fields, w.Header().Get("X-Request-ID"), version})
}

// allowPasswordAttempt limits direct source requests without trusting proxy input.
func (app *App) allowPasswordAttempt(r *http.Request) bool {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	now := app.Now()
	app.mu.Lock()
	defer app.mu.Unlock()
	for key, window := range app.attempts {
		if !now.Before(window.Until) {
			delete(app.attempts, key)
		}
	}
	window, exists := app.attempts[peer]
	if !exists {
		if len(app.attempts) >= 1024 {
			return false
		}
		window.Until = now.Add(time.Minute)
	}
	if window.Count >= 20 {
		return false
	}
	window.Count++
	app.attempts[peer] = window
	return true
}

// static serves only the configured build directory and its SPA entry point.
func (app *App) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := filepath.Clean("/" + r.URL.Path)
	if strings.HasPrefix(path, "/.") || strings.Contains(path, "/.") {
		http.NotFound(w, r)
		return
	}
	filename := filepath.Join(app.Config.StaticDirectory, filepath.FromSlash(path))
	info, err := os.Stat(filename)
	if err == nil && !info.IsDir() {
		http.ServeFile(w, r, filename)
		return
	}
	if filepath.Ext(path) != "" {
		http.NotFound(w, r)
		return
	}
	index := filepath.Join(app.Config.StaticDirectory, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, index)
}
