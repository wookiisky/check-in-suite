package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/assets"
)

// TestControlledAssetsHTTP checks authentication and real SVG bytes through the public routes.
func TestControlledAssetsHTTP(t *testing.T) {
	app := accountApplication(t)
	service := assets.New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	app.RegisterAssets(service)
	for _, path := range []string{"/api/v1/assets", "/api/v1/assets/fox-v1"} {
		response := apiRequest(app, "GET", path, "", nil, "")
		if response.Code != 401 {
			t.Fatalf("private asset exposed at %s: %d", path, response.Code)
		}
	}
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	response := apiRequest(app, "GET", "/api/v1/assets", "", cookie, "")
	if response.Code != 200 {
		t.Fatalf("catalog: %d %s", response.Code, response.Body)
	}
	var catalog struct {
		Items []assets.Asset `json:"items"`
	} // Serialized public catalog.
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil || len(catalog.Items) == 0 {
		t.Fatalf("catalog: %v %s", err, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/assets/fox-v1", "", cookie, "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/svg+xml" || !strings.Contains(response.Body.String(), "<svg") {
		t.Fatalf("SVG: %d %s", response.Code, response.Body)
	}
	if response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("asset headers: %v", response.Header())
	}
	response = apiRequest(app, "GET", "/api/v1/assets/missing-v1", "", cookie, "")
	if response.Code != 404 {
		t.Fatalf("missing resource: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/auth/logout", "", cookie, jsonCSRF(t, login.Body.Bytes()))
	if response.Code != 204 {
		t.Fatalf("logout: %d", response.Code)
	}
	response = apiRequest(app, "GET", "/api/v1/assets/fox-v1", "", cookie, "")
	if response.Code != 401 {
		t.Fatalf("revoked session read asset: %d", response.Code)
	}
}

// jsonCSRF extracts the actual session token from a serialized login response.
func jsonCSRF(t *testing.T, data []byte) string {
	t.Helper()
	var session struct {
		Token string `json:"csrf_token"`
	} // CSRF value bound to the real HTTP session.
	if err := json.Unmarshal(data, &session); err != nil {
		t.Fatal(err)
	}
	return session.Token
}
