package httpapi

import (
	"github.com/wookiisky/check-in-suite/internal/island"
	"net/http"
)

// registerIslandActivityAccess keeps task eligibility independent from layout and inventory reads.
func (app *App) registerIslandActivityAccess(service *island.Service) {
	app.Mux.HandleFunc("GET /api/v1/island/activity-access", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		state, err := service.ReadActivityAccess(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
}
