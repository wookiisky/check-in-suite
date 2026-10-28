package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// RegisterQueries exposes calendar and statistics reads without accepting client-provided authority.
func (app *App) RegisterQueries(service *checkin.Service) {
	app.Mux.HandleFunc("GET /api/v1/calendar", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Calendar(r.Context(), p, r.URL.Query().Get("month"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
	app.Mux.HandleFunc("GET /api/v1/stats", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		query := r.URL.Query()
		result, err := service.Stats(r.Context(), p, query.Get("start_date"), query.Get("end_date"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
}
