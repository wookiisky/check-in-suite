package httpapi

import (
	"encoding/json"
	"testing"
)

// TestPreferencesRejectNullAtomically preserves omitted fields while accepting explicit false.
func TestPreferencesRejectNullAtomically(t *testing.T) {
	app := accountApplication(t)
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	var session struct {
		CSRF string `json:"csrf_token"`
	} // Request token returned by the real login.
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	response := apiRequest(app, "PATCH", "/api/v1/account/preferences", `{"music_enabled":true,"effects_enabled":null}`, cookie, session.CSRF)
	if response.Code != 400 {
		t.Fatalf("explicit null accepted: %d %s", response.Code, response.Body)
	}
	var music, effects bool
	if err := app.DB.QueryRow("SELECT music_enabled,effects_enabled FROM accounts WHERE id=1").Scan(&music, &effects); err != nil {
		t.Fatal(err)
	}
	if music || !effects {
		t.Fatalf("invalid request partially changed preferences: music=%v effects=%v", music, effects)
	}
	response = apiRequest(app, "PATCH", "/api/v1/account/preferences", `{"effects_enabled":false}`, cookie, session.CSRF)
	if response.Code != 200 {
		t.Fatalf("explicit false rejected: %d %s", response.Code, response.Body)
	}
	if err := app.DB.QueryRow("SELECT music_enabled,effects_enabled FROM accounts WHERE id=1").Scan(&music, &effects); err != nil {
		t.Fatal(err)
	}
	if music || effects {
		t.Fatalf("false update or omitted field incorrect: music=%v effects=%v", music, effects)
	}
}
