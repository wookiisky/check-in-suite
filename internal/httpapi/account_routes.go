package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// registerAccounts keeps route authority in the server, never in request fields.
func (app *App) registerAccounts() {
	app.Mux.HandleFunc("POST /api/v1/auth/login", app.login)
	app.Mux.HandleFunc("GET /api/v1/session", app.session)
	app.Mux.HandleFunc("POST /api/v1/auth/logout", app.logout)
	app.Mux.HandleFunc("POST /api/v1/management/unlock", app.unlock)
	app.Mux.HandleFunc("POST /api/v1/management/lock", app.lock)
	app.Mux.HandleFunc("PATCH /api/v1/account/profile", app.profile)
	app.Mux.HandleFunc("PATCH /api/v1/account/preferences", app.preferences)
	app.Mux.HandleFunc("POST /api/v1/account/login-password", app.password("login"))
	app.Mux.HandleFunc("POST /api/v1/account/management-password", app.password("management"))
}

// authenticatedWrite checks the HTTP protections; services recheck within transactions.
func (app *App) authenticatedWrite(r *http.Request) (account.Principal, error) {
	principal, err := app.Authenticate(r)
	if err != nil {
		return principal, err
	}
	return principal, app.MutationGuard(r, principal)
}

// login verifies the request source before performing expensive credential work.
func (app *App) login(w http.ResponseWriter, r *http.Request) {
	if err := app.originGuard(r); err != nil {
		WriteError(w, r, err)
		return
	}
	if !app.allowPasswordAttempt(r) {
		WriteError(w, r, &core.Error{Status: 429, Code: "TOO_MANY_ATTEMPTS"})
		return
	}
	var input struct {
		Username string `json:"username"` // Immutable login identifier.
		Password string `json:"password"` // Plain password used only during this request.
	}
	if err := DecodeJSON(w, r, &input); err != nil {
		WriteError(w, r, err)
		return
	}
	token, session, err := app.Accounts.Login(r.Context(), input.Username, input.Password)
	if err != nil {
		app.recordPasswordFailure(r, err)
		WriteError(w, r, err)
		return
	}
	app.setCookie(w, token, int(app.Config.SessionTTL.Seconds()))
	WriteJSON(w, 200, session)
}

// session returns the authenticated account and server-side authorization state.
func (app *App) session(w http.ResponseWriter, r *http.Request) {
	principal, err := app.Authenticate(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	session, err := app.Accounts.Session(r.Context(), principal)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, 200, session)
}

// logout revokes the server session before clearing the browser cookie.
func (app *App) logout(w http.ResponseWriter, r *http.Request) {
	principal, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	if err := app.Accounts.Logout(r.Context(), principal); err != nil {
		WriteError(w, r, err)
		return
	}
	app.setCookie(w, "", -1)
	WriteJSON(w, 204, nil)
}

// unlock asks for a fresh management password on every new entry.
func (app *App) unlock(w http.ResponseWriter, r *http.Request) {
	principal, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	if !app.allowPasswordAttempt(r) {
		WriteError(w, r, &core.Error{Status: 429, Code: "TOO_MANY_ATTEMPTS"})
		return
	}
	var input struct {
		Password string `json:"password"`
	} // Credential is not retained after verification.
	if err := DecodeJSON(w, r, &input); err != nil {
		WriteError(w, r, err)
		return
	}
	expires, err := app.Accounts.Unlock(r.Context(), principal, input.Password)
	if err != nil {
		app.recordPasswordFailure(r, err)
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, 200, struct {
		Expires string `json:"management_expires_at"`
	}{expires.UTC().Format(time.RFC3339Nano)})
}

// lock revokes management access without ending the normal login session.
func (app *App) lock(w http.ResponseWriter, r *http.Request) {
	principal, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	if err := app.Accounts.Lock(r.Context(), principal); err != nil {
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, 204, nil)
}

// profile changes only the display name with optimistic version checking.
func (app *App) profile(w http.ResponseWriter, r *http.Request) {
	principal, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	var input struct {
		DisplayName     string `json:"display_name"`     // Name shown throughout the application.
		ExpectedVersion int64  `json:"expected_version"` // Version confirmed by the user.
	}
	if err := DecodeJSON(w, r, &input); err != nil {
		WriteError(w, r, err)
		return
	}
	result, err := app.Accounts.UpdateProfile(r.Context(), principal, input.DisplayName, input.ExpectedVersion)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, 200, result)
}

// preferences updates only provided preference fields, preserving independent changes.
func (app *App) preferences(w http.ResponseWriter, r *http.Request) {
	principal, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	var input account.PreferencesPatch
	if err := decodeRequiredJSON(w, r, &input, nil); err != nil {
		WriteError(w, r, err)
		return
	}
	result, err := app.Accounts.UpdatePreferences(r.Context(), principal, input)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, 200, result)
}

// password binds the credential type to its route rather than a client selector.
func (app *App) password(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		if !app.allowPasswordAttempt(r) {
			WriteError(w, r, &core.Error{Status: 429, Code: "TOO_MANY_ATTEMPTS"})
			return
		}
		var input struct {
			Old     string `json:"old_password"`     // Existing password for the selected credential.
			New     string `json:"new_password"`     // Replacement password.
			Confirm string `json:"confirm_password"` // Independent confirmation.
		}
		if err := DecodeJSON(w, r, &input); err != nil {
			WriteError(w, r, err)
			return
		}
		if err := app.Accounts.ChangePassword(r.Context(), principal, kind, input.Old, input.New, input.Confirm); err != nil {
			app.recordPasswordFailure(r, err)
			WriteError(w, r, err)
			return
		}
		app.setCookie(w, "", -1)
		WriteJSON(w, 204, nil)
	}
}

// setCookie uses the configured public scheme, never spoofable forwarded headers.
func (app *App) setCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(app.Config.PublicOrigin, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}
