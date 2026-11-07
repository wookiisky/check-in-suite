package httpapi

import (
	"net/http"
	"strconv"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// registerGroups keeps fresh password checks separate from management-page authorization.
func (app *App) registerGroups() {
	app.Mux.HandleFunc("GET /api/v1/groups", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := app.Accounts.Groups(r.Context(), p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
	app.Mux.HandleFunc("POST /api/v1/groups/join", app.joinGroup)
	app.Mux.HandleFunc("POST /api/v1/groups/leave", app.leaveGroup)
}

// joinGroup validates this account's password on each membership change.
func (app *App) joinGroup(w http.ResponseWriter, r *http.Request) {
	p, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	if !app.allowPasswordAttempt(r) {
		WriteError(w, r, core.Fail(429, "TOO_MANY_ATTEMPTS"))
		return
	}
	var input struct {
		GroupID  int64  `json:"group_id"` // Existing group chosen by this account.
		Password string `json:"password"` // Fresh management credential, never persisted.
	}
	if err := decodeRequiredJSON(w, r, &input, []string{"group_id", "password"}); err != nil {
		WriteError(w, r, err)
		return
	}
	if input.GroupID < 1 || input.GroupID > 9007199254740991 {
		WriteError(w, r, core.Invalid("group_id", "INVALID_NUMBER"))
		return
	}
	result, err := app.Accounts.JoinGroup(r.Context(), p, input.GroupID, input.Password)
	if err != nil {
		app.recordPasswordFailure(r, err)
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, result)
}

// leaveGroup removes only the current account's membership after a fresh password check.
func (app *App) leaveGroup(w http.ResponseWriter, r *http.Request) {
	p, err := app.authenticatedWrite(r)
	if err != nil {
		WriteError(w, r, err)
		return
	}
	if !app.allowPasswordAttempt(r) {
		WriteError(w, r, core.Fail(429, "TOO_MANY_ATTEMPTS"))
		return
	}
	var input struct {
		Password string `json:"password"`
	} // Used only for this membership change.
	if err := decodeRequiredJSON(w, r, &input, []string{"password"}); err != nil {
		WriteError(w, r, err)
		return
	}
	result, err := app.Accounts.LeaveGroup(r.Context(), p, input.Password)
	if err != nil {
		app.recordPasswordFailure(r, err)
		WriteError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, result)
}

// readAccountID parses a read target without changing the authenticated principal.
func readAccountID(r *http.Request, p account.Principal) (int64, error) {
	if !r.URL.Query().Has("account_id") {
		return p.AccountID, nil
	}
	id, err := strconv.ParseInt(r.URL.Query().Get("account_id"), 10, 64)
	if err != nil || id < 1 || id > 9007199254740991 {
		return 0, core.Invalid("account_id", "INVALID_NUMBER")
	}
	return id, nil
}
