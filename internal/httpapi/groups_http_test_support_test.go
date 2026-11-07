package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
)

// groupHTTPUser retains browser credentials for one independently logged-in account.
type groupHTTPUser struct {
	cookie  *http.Cookie    // Opaque login cookie.
	session account.Session // Account identity and CSRF token returned by the server.
}

// loginGroupHTTPUser uses the public login endpoint and unlocks only this browser session.
func loginGroupHTTPUser(t *testing.T, app *App, username string) groupHTTPUser {
	t.Helper()
	response := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"`+username+`","password":"login-password"}`, nil, "")
	var user groupHTTPUser
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &user.session) != nil {
		t.Fatalf("login %s: %d %s", username, response.Code, response.Body)
	}
	user.cookie = response.Result().Cookies()[0]
	response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, user.cookie, user.session.CSRFToken)
	if response.Code != 200 {
		t.Fatalf("unlock %s: %d %s", username, response.Code, response.Body)
	}
	return user
}
