package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// RegisterQueries exposes calendar and statistics reads without accepting client-provided authority.
func (app *App) RegisterQueries(service *checkin.Service) {
	app.Mux.HandleFunc("GET /api/v1/group-today", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		targetID, err := readAccountID(r, p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.MemberToday(r.Context(), p, targetID)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})

	app.Mux.HandleFunc("GET /api/v1/calendar", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		targetID, err := readAccountID(r, p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.CalendarFor(r.Context(), p, targetID, r.URL.Query().Get("month"))
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
		targetID, err := readAccountID(r, p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.StatsFor(r.Context(), p, targetID, query.Get("start_date"), query.Get("end_date"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
}
