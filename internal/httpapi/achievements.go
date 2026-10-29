package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/achievement"
)

// RegisterAchievements keeps configuration authority on management routes and equipment on ordinary routes.
func (app *App) RegisterAchievements(service *achievement.Service) {
	for _, route := range []struct {
		Path       string // Route fixes the required authority independently of input.
		Management bool   // Management lists include inactive definitions.
	}{{"/api/v1/achievements", false}, {"/api/v1/management/achievements", true}} {
		app.Mux.HandleFunc("GET "+route.Path, func(w http.ResponseWriter, r *http.Request) {
			principal, err := app.Authenticate(r)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			result, err := service.List(r.Context(), principal, route.Management)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			WriteJSON(w, http.StatusOK, result)
		})
	}
	app.Mux.HandleFunc("GET /api/v1/management/achievements/options", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Options(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
	app.Mux.HandleFunc("POST /api/v1/management/achievements", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input achievement.Input
		if err := decodeRequiredJSON(w, r, &input, []string{"name", "asset_key", "metric", "scope", "category_id", "task_ids", "target", "window_days", "enabled"}, "category_id", "window_days"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Create(r.Context(), principal, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusCreated, result)
	})
	app.Mux.HandleFunc("PATCH /api/v1/management/achievements/{id}", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input achievement.UpdateInput
		if err := decodeRequiredJSON(w, r, &input, []string{"name", "asset_key", "metric", "scope", "category_id", "task_ids", "target", "window_days", "enabled", "expected_version"}, "category_id", "window_days"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Update(r.Context(), principal, r.PathValue("id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
	app.Mux.HandleFunc("DELETE /api/v1/management/achievements/{id}", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input versionRequest
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		if err := service.Delete(r.Context(), principal, r.PathValue("id"), input.ExpectedVersion); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusNoContent, nil)
	})
	app.Mux.HandleFunc("PUT /api/v1/achievements/{id}/equipment", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			Equipped bool `json:"equipped"` // Absolute desired state makes repeat requests safe.
		}
		if err := decodeRequiredJSON(w, r, &input, []string{"equipped"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.SetEquipped(r.Context(), principal, r.PathValue("id"), input.Equipped)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
	})
}
