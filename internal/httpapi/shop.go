package httpapi

import (
	"net/http"
	"strconv"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// RegisterShop keeps management authority fixed by the route and delegates economic writes to the service.
func (app *App) RegisterShop(service *shop.Service) {
	app.registerAppearance(service)
	app.Mux.HandleFunc("GET /api/v1/shop/products", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		query := r.URL.Query()
		input := shop.ShopQuery{Group: query.Get("group"), Category: query.Get("category"), Page: 1, Limit: 24}
		if query.Has("page") {
			input.Page, err = strconv.Atoi(query.Get("page"))
			if err != nil {
				WriteError(w, r, core.Invalid("page", "INVALID_VALUE"))
				return
			}
		}
		if query.Has("limit") {
			input.Limit, err = strconv.Atoi(query.Get("limit"))
			if err != nil {
				WriteError(w, r, core.Invalid("limit", "INVALID_VALUE"))
				return
			}
		}
		result, err := service.BrowseShop(r.Context(), p, input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result.DevelopmentBuyAll = app.Config.Development
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("POST /api/v1/shop/development/buy-all", func(w http.ResponseWriter, r *http.Request) {
		if !app.Config.Development {
			WriteError(w, r, core.Fail(404, "NOT_FOUND"))
			return
		}
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		balance, err := service.DevelopmentBuyAll(r.Context(), p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, balance)
	})
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
		query := r.URL.Query()
		var result shop.ProductList
		paged := false
		for _, field := range []string{"limit", "cursor", "type", "group", "category", "slot", "search", "provider", "pack_key"} {
			paged = paged || query.Has(field)
		}
		if paged {
			limit := 48
			if query.Has("limit") {
				var parseErr error
				limit, parseErr = strconv.Atoi(query.Get("limit"))
				if parseErr != nil || limit < 1 || limit > 100 {
					WriteError(w, r, core.Invalid("limit", "INVALID_VALUE"))
					return
				}
			}
			result, err = service.ListProductsPage(r.Context(), p, inactive, shop.ProductQuery{Limit: limit, Cursor: query.Get("cursor"), Type: query.Get("type"), Group: query.Get("group"), Category: query.Get("category"), Slot: query.Get("slot"), Search: query.Get("search"), Provider: query.Get("provider"), PackKey: query.Get("pack_key")})
		} else {
			result, err = service.ListProducts(r.Context(), p, inactive)
		}
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
		var input shop.ProductCreate
		if err = decodeRequiredJSON(w, r, &input, []string{"asset_key", "name", "coin_price", "diamond_price", "stock", "enabled"}, "stock"); err != nil {
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
		if err = decodeRequiredJSON(w, r, &input, []string{"name", "coin_price", "diamond_price", "stock", "enabled", "expected_version"}, "stock"); err != nil {
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
	app.Mux.HandleFunc("GET /api/v1/management/materials", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.ListManagementMaterials(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, result)
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
		input := shop.PurchaseQuery{Type: query.Get("type"), Status: query.Get("status"), Cursor: query.Get("cursor"), Group: query.Get("group"), Slot: query.Get("slot"), Search: query.Get("search"), Provider: query.Get("provider"), PackKey: query.Get("pack_key")}
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
	app.Mux.HandleFunc("PUT /api/v1/equipment/title", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			PurchaseID *string `json:"purchase_id"`
		} // Explicit null clears only the title.
		if err = decodeRequiredJSON(w, r, &input, []string{"purchase_id"}, "purchase_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.SetTitle(r.Context(), p, input.PurchaseID)
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
