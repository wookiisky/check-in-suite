package httpapi

import (
	"net/http"
	"strconv"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// RegisterShop keeps management authority fixed by the route and delegates economic writes to the service.
func (app *App) RegisterShop(service *shop.Service) {
	app.Mux.HandleFunc("GET /api/v1/products", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		inactive := false
		if raw := r.URL.Query().Get("include_inactive"); raw != "" {
			if raw != "true" && raw != "false" {
				WriteError(w, r, core.Invalid("include_inactive", "INVALID_VALUE"))
				return
			}
			inactive = raw == "true"
		}
		result, err := service.ListProducts(r.Context(), p, inactive)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("POST /api/v1/management/products", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input shop.ProductInput
		if err = decodeRequiredJSON(w, r, &input, []string{"type", "name", "asset_key", "description", "coin_price", "diamond_price", "stock", "enabled"}, "stock"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.CreateProduct(r.Context(), p, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 201, result)
	})
	app.Mux.HandleFunc("PATCH /api/v1/management/products/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input shop.ProductUpdate
		if err = decodeRequiredJSON(w, r, &input, []string{"type", "name", "asset_key", "description", "coin_price", "diamond_price", "stock", "enabled", "expected_version"}, "stock"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.UpdateProduct(r.Context(), p, r.PathValue("id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("DELETE /api/v1/management/products/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			ExpectedVersion int64 `json:"expected_version"`
		} // Reviewed product version.
		if err = decodeRequiredJSON(w, r, &input, []string{"expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		if err = service.DeleteProduct(r.Context(), p, r.PathValue("id"), input.ExpectedVersion); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 204, nil)
	})
	app.Mux.HandleFunc("POST /api/v1/purchases", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input shop.BuyInput
		if err = decodeRequiredJSON(w, r, &input, []string{"product_id", "expected_product_version", "expected_wallet_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Buy(r.Context(), p, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 201, result)
	})
	app.Mux.HandleFunc("GET /api/v1/purchases", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		query := r.URL.Query()
		input := shop.PurchaseQuery{Type: query.Get("type"), Status: query.Get("status"), Cursor: query.Get("cursor")}
		if query.Has("limit") {
			input.Limit, err = strconv.Atoi(query.Get("limit"))
			if err != nil || input.Limit < 1 || input.Limit > 100 {
				WriteError(w, r, core.Invalid("limit", "INVALID_VALUE"))
				return
			}
		}
		result, err := service.ListPurchases(r.Context(), p, input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("PUT /api/v1/equipment/base-avatar", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			AssetKey string `json:"asset_key"`
		} // One free base character, no purchase required.
		if err = decodeRequiredJSON(w, r, &input, []string{"asset_key"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.SetBaseAvatar(r.Context(), p, input.AssetKey)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("PUT /api/v1/equipment/{slot}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			PurchaseID *string `json:"purchase_id"`
		} // Explicit null resets only this slot.
		if err = decodeRequiredJSON(w, r, &input, []string{"purchase_id"}, "purchase_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.SetSlot(r.Context(), p, r.PathValue("slot"), input.PurchaseID)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		app.Mux.HandleFunc(method+" /api/v1/equipment/accessories/{purchase_id}", func(w http.ResponseWriter, r *http.Request) {
			p, err := app.authenticatedWrite(r)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			result, err := service.SetAccessory(r.Context(), p, r.PathValue("purchase_id"), r.Method == http.MethodPut)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			WriteJSON(w, 200, result)
		})
		app.Mux.HandleFunc(method+" /api/v1/equipment/effects/{purchase_id}", func(w http.ResponseWriter, r *http.Request) {
			p, err := app.authenticatedWrite(r)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			result, err := service.SetEffect(r.Context(), p, r.PathValue("purchase_id"), r.Method == http.MethodPut)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			WriteJSON(w, 200, result)
		})
	}
	app.Mux.HandleFunc("PATCH /api/v1/equipment/accessories/{purchase_id}/layout", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input shop.AccessoryLayoutInput
		if err = decodeRequiredJSON(w, r, &input, []string{"x", "y", "size", "rotation", "before_id"}, "before_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.SetAccessoryLayout(r.Context(), p, r.PathValue("purchase_id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("POST /api/v1/purchases/{id}/redeem", func(w http.ResponseWriter, r *http.Request) {
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
		} // Used only for this redemption, never persisted.
		if err = decodeRequiredJSON(w, r, &input, []string{"password"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Redeem(r.Context(), p, r.PathValue("id"), input.Password)
		if err != nil {
			app.recordPasswordFailure(r, err)
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
}
