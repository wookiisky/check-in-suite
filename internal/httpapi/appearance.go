package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// registerAppearance separates complete 3D appearance writes from the legacy single-slot endpoints.
func (app *App) registerAppearance(service *shop.Service) {
	app.Mux.HandleFunc("GET /api/v1/appearance", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		state, err := service.Appearance(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
	app.Mux.HandleFunc("PUT /api/v1/appearance", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input shop.SaveAppearanceInput
		if err := decodeRequiredJSON(w, r, &input,
			[]string{"expected_version", "character_key", "face_purchase_id", "head_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id", "back_purchase_id"},
			"face_purchase_id", "head_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id", "back_purchase_id",
			"face_free_wearable_key", "head_free_wearable_key", "upper_free_wearable_key", "lower_free_wearable_key", "shoes_free_wearable_key", "back_free_wearable_key",
			"upper_color_key", "back_color_key"); err != nil {
			WriteError(w, r, err)
			return
		}
		state, err := service.SaveAppearance(r.Context(), principal, input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
}
