package httpapi

import (
	"net/http"
	"strconv"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/message"
)

// RegisterMessages keeps private household reads and writes behind the normal login session.
func (app *App) RegisterMessages(service *message.Service) {
	app.Mux.HandleFunc("GET /api/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		limit := 50
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, err = strconv.Atoi(raw)
			if err != nil {
				WriteError(w, r, core.Invalid("limit", "INVALID_NUMBER"))
				return
			}
		}
		result, err := service.List(r.Context(), p, r.URL.Query().Get("cursor"), limit)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
	app.Mux.HandleFunc("POST /api/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input message.CreateInput
		if err := DecodeJSON(w, r, &input); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Create(r.Context(), p, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusCreated, result)
	})
	app.Mux.HandleFunc("DELETE /api/v1/messages/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		if err := service.Delete(r.Context(), p, r.PathValue("id")); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusNoContent, nil)
	})
}
