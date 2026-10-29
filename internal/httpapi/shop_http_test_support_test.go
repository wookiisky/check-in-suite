package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// shopHTTPRequest creates an unlocked real-database HTTP fixture with authenticated writes.
func shopHTTPRequest(t *testing.T) (*App, func(string, string, string, string) *httptest.ResponseRecorder) {
	t.Helper()
	app := accountApplication(t)
	app.RegisterShop(shop.New(app.DB, app.Config, app.Accounts))
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	var session struct {
		CSRF string `json:"csrf_token"`
	} // Server-issued request authorization token.
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if unlocked := apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF); unlocked.Code != 200 {
		t.Fatalf("unlock: %d %s", unlocked.Code, unlocked.Body)
	}
	return app, func(method, path, body, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "https://island.example"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://island.example")
		req.Header.Set("X-CSRF-Token", session.CSRF)
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(cookie)
		response := httptest.NewRecorder()
		app.ServeHTTP(response, req)
		return response
	}
}
