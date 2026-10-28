package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// accountApplication uses a migrated file database and the real account service.
func accountApplication(t *testing.T) *App {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "account.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.PublicOrigin = "https://island.example"
	svc := account.New(db, cfg)
	if err := svc.Initialize(context.Background(), "family", "小岛", "login-password", "manage-password"); err != nil {
		t.Fatal(err)
	}
	return NewApplication(&Readiness{DB: db}, cfg, svc)
}

// apiRequest runs actual HTTP serialization and cookie/header propagation.
func apiRequest(app *App, method, path, body string, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Origin", app.Config.PublicOrigin)
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	response := httptest.NewRecorder()
	app.ServeHTTP(response, req)
	return response
}

// TestAccountHTTP exercises login, protection, unlock, lock and session revocation.
func TestAccountHTTP(t *testing.T) {
	app := accountApplication(t)
	response := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if response.Code != 200 {
		t.Fatalf("login: %d %s", response.Code, response.Body)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != "/" {
		t.Fatalf("invalid session cookie: %+v", cookies)
	}
	var session struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil || session.CSRF == "" {
		t.Fatalf("session: %s %v", response.Body, err)
	}
	cookie := cookies[0]
	response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, "")
	if response.Code != 403 {
		t.Fatalf("missing CSRF accepted: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password","is_admin":true}`, cookie, session.CSRF)
	if response.Code != 400 {
		t.Fatalf("unknown field accepted: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF)
	if response.Code != 200 {
		t.Fatalf("unlock: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "PATCH", "/api/v1/account/profile", `{"display_name":"新小岛","expected_version":1}`, cookie, session.CSRF)
	if response.Code != 200 {
		t.Fatalf("profile: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "POST", "/api/v1/management/lock", "", cookie, session.CSRF)
	if response.Code != 204 {
		t.Fatalf("lock: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "PATCH", "/api/v1/account/profile", `{"display_name":"禁止","expected_version":2}`, cookie, session.CSRF)
	if response.Code != 403 {
		t.Fatalf("locked write accepted: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/auth/logout", "", cookie, session.CSRF)
	if response.Code != 204 {
		t.Fatalf("logout: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/session", "", cookie, "")
	if response.Code != 401 {
		t.Fatalf("revoked session accepted: %d", response.Code)
	}
}

// TestRequestProtection rejects forged origins and preserves structured errors.
func TestRequestProtection(t *testing.T) {
	app := accountApplication(t)
	request := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"username":"family","password":"login-password"}`))
	request.Header.Set("Origin", "https://elsewhere.example")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("forged origin: %d", response.Code)
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["code"] == nil || result["field_errors"] == nil || result["request_id"] == "" {
		t.Fatalf("error contract: %v", result)
	}
	response = apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"} {}`, nil, "")
	if response.Code != 400 {
		t.Fatalf("multiple JSON values accepted: %d", response.Code)
	}
}

// TestDecodeJSONObjects rejects null and other valid JSON values outside the request-object contract.
func TestDecodeJSONObjects(t *testing.T) {
	for _, test := range []struct {
		body  string // Actual serialized request bytes.
		valid bool   // Whether this is a complete object matching the target schema.
	}{
		{`null`, false}, {` null `, false}, {`[]`, false}, {`true`, false}, {`42`, false}, {`"text"`, false},
		{" \n\t\r", false}, {`{}`, true}, {" \n\t\r{\"enabled\":true}", true},
		{`{"enabled":true} null`, false}, {`{"unknown":true}`, false},
	} {
		t.Run(test.body, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			var destination struct {
				Enabled bool `json:"enabled"`
			} // Optional request field.
			err := DecodeJSON(httptest.NewRecorder(), request, &destination)
			if (err == nil) != test.valid {
				t.Fatalf("DecodeJSON error=%v valid=%v", err, test.valid)
			}
		})
	}
}

// TestPasswordHTTP proves a successful credential change revokes the old browser cookie.
func TestPasswordHTTP(t *testing.T) {
	app := accountApplication(t)
	response := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if response.Code != 200 {
		t.Fatalf("login: %d %s", response.Code, response.Body)
	}
	cookie := response.Result().Cookies()[0]
	var session struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF)
	if response.Code != 200 {
		t.Fatalf("unlock: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "POST", "/api/v1/account/login-password", `{"old_password":"login-password","new_password":"updated-password","confirm_password":"different-password"}`, cookie, session.CSRF)
	if response.Code != 400 {
		t.Fatalf("mismatched confirmation: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "POST", "/api/v1/account/login-password", `{"old_password":"login-password","new_password":"updated-password","confirm_password":"updated-password"}`, cookie, session.CSRF)
	if response.Code != 204 || response.Result().Cookies()[0].MaxAge != -1 {
		t.Fatalf("change password: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/session", "", cookie, "")
	if response.Code != 401 {
		t.Fatalf("old cookie survived password change: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"updated-password"}`, nil, "")
	if response.Code != 200 {
		t.Fatalf("replacement password: %d %s", response.Code, response.Body)
	}
}

// TestSuccessfulAuthenticationDoesNotConsumeFailureBudget exercises more than twenty real successful password checks.
func TestSuccessfulAuthenticationDoesNotConsumeFailureBudget(t *testing.T) {
	app := accountApplication(t)
	for i := 0; i < 11; i++ {
		login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
		if login.Code != 200 {
			t.Fatalf("login %d: %d %s", i+1, login.Code, login.Body)
		}
		var session struct {
			CSRF string `json:"csrf_token"`
		} // Session-bound request token.
		if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
			t.Fatal(err)
		}
		cookie := login.Result().Cookies()[0]
		unlock := apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF)
		if unlock.Code != 200 {
			t.Fatalf("unlock %d: %d %s", i+1, unlock.Code, unlock.Body)
		}
		logout := apiRequest(app, "POST", "/api/v1/auth/logout", "", cookie, session.CSRF)
		if logout.Code != 204 {
			t.Fatalf("logout: %d %s", logout.Code, logout.Body)
		}
	}
	if len(app.attempts) != 0 {
		t.Fatalf("successful passwords created failure windows: %v", app.attempts)
	}
}

// TestSourceRateLimitRecovery verifies bounded work and fixed-window recovery.
func TestSourceRateLimitRecovery(t *testing.T) {
	app := &App{Now: time.Now, attempts: make(map[string]sourceAttempts)}
	now := time.Now()
	app.Now = func() time.Time { return now }
	request := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
	for i := 0; i < 20; i++ {
		if !app.allowPasswordAttempt(request) {
			t.Fatal("source limited before threshold")
		}
		app.recordPasswordFailure(request, core.Fail(401, "INVALID_CREDENTIALS"))
	}
	if app.allowPasswordAttempt(request) {
		t.Fatal("source threshold not enforced")
	}
	now = now.Add(time.Minute)
	if !app.allowPasswordAttempt(request) {
		t.Fatal("source remained permanently locked")
	}
}

// TestSourceFailureCounting ignores noncredential errors and bounds concurrent source buckets.
func TestSourceFailureCounting(t *testing.T) {
	app := &App{Now: time.Now, attempts: make(map[string]sourceAttempts)}
	request := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
	for _, failure := range []error{nil, core.Invalid("password", "REQUIRED"), core.Fail(409, "MANAGEMENT_CHANGED"), core.VersionConflict(2)} {
		app.recordPasswordFailure(request, failure)
	}
	if len(app.attempts) != 0 {
		t.Fatal("noncredential failures consumed the failure budget")
	}
	var concurrent sync.WaitGroup
	for i := 0; i < 40; i++ {
		concurrent.Add(1)
		go func() {
			defer concurrent.Done()
			app.recordPasswordFailure(request, core.Fail(422, "INVALID_CREDENTIALS"))
			app.allowPasswordAttempt(request)
		}()
	}
	concurrent.Wait()
	if app.allowPasswordAttempt(request) || app.attempts[passwordSource(request)].Count != 20 {
		t.Fatal("concurrent failures did not enforce the bounded threshold")
	}
	for i := 0; i < 1025; i++ {
		request := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
		request.RemoteAddr = "peer-" + strconv.Itoa(i)
		app.recordPasswordFailure(request, core.Fail(401, "INVALID_CREDENTIALS"))
	}
	if len(app.attempts) != 1024 {
		t.Fatalf("source map size=%d", len(app.attempts))
	}
}

// TestAuthenticationRoutesCountOnlyInvalidCredentials covers all three password endpoint families.
func TestAuthenticationRoutesCountOnlyInvalidCredentials(t *testing.T) {
	app := accountApplication(t)
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	var session struct {
		CSRF string `json:"csrf_token"`
	} // Token from the actual login response.
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	for _, test := range []struct {
		path   string // Password verification route.
		body   string // Incorrect credentials with otherwise valid input.
		status int    // Expected localized-authentication failure response.
	}{
		{"/auth/login", `{"username":"family","password":"wrong-password"}`, 401},
		{"/management/unlock", `{"password":"wrong-password"}`, 422},
	} {
		response := apiRequest(app, "POST", "/api/v1"+test.path, test.body, cookie, session.CSRF)
		if response.Code != test.status {
			t.Fatalf("%s: %d %s", test.path, response.Code, response.Body)
		}
	}
	unlock := apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF)
	if unlock.Code != 200 {
		t.Fatalf("unlock: %d %s", unlock.Code, unlock.Body)
	}
	change := apiRequest(app, "POST", "/api/v1/account/login-password", `{"old_password":"wrong-password","new_password":"replacement-password","confirm_password":"replacement-password"}`, cookie, session.CSRF)
	if change.Code != 422 {
		t.Fatalf("password: %d %s", change.Code, change.Body)
	}
	for i := 0; i < 25; i++ {
		response := apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":null}`, cookie, session.CSRF)
		if response.Code != 400 {
			t.Fatalf("invalid field: %d %s", response.Code, response.Body)
		}
	}
	if len(app.attempts) != 1 {
		t.Fatalf("unexpected sources: %v", app.attempts)
	}
	for _, window := range app.attempts {
		if window.Count != 3 {
			t.Fatalf("failure count=%d want=3", window.Count)
		}
	}
}

// TestProductionStaticBoundary proves SPA fallback never substitutes for missing private or API paths.
func TestProductionStaticBoundary(t *testing.T) {
	app := accountApplication(t)
	app.Config.StaticDirectory = t.TempDir()
	if err := os.WriteFile(filepath.Join(app.Config.StaticDirectory, "index.html"), []byte("<main>island</main>"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		Path   string // Requested public or private URL.
		Status int    // Expected HTTP result.
	}{{"/calendar", 200}, {"/.local/island.db", 404}, {"/missing.js", 404}, {"/api/v1/missing", 404}} {
		response := apiRequest(app, "GET", tc.Path, "", nil, "")
		if response.Code != tc.Status {
			t.Fatalf("%s: %d %s", tc.Path, response.Code, response.Body)
		}
	}
}

// TestStorageFailureResponse exposes an actionable code without disclosing filesystem details.
func TestStorageFailureResponse(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "storage-test")
	request := httptest.NewRequest("POST", "/api/v1/checkins", nil)
	WriteError(response, request, &os.PathError{Op: "write", Path: "/private/family/island.db", Err: syscall.ENOSPC})
	if response.Code != 503 || !strings.Contains(response.Body.String(), `"code":"STORAGE_UNAVAILABLE"`) || strings.Contains(response.Body.String(), "/private/") {
		t.Fatalf("storage response: %d %s", response.Code, response.Body)
	}
}
