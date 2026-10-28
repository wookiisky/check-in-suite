package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestShopHTTP verifies real JSON, route authority and an idempotent purchase on the file database.
func TestShopHTTP(t *testing.T) {
	app := accountApplication(t)
	app.RegisterShop(shop.New(app.DB, app.Config, app.Accounts))
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	var session struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", app.Config.PublicOrigin)
		req.Header.Set("X-CSRF-Token", session.CSRF)
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(cookie)
		response := httptest.NewRecorder()
		app.ServeHTTP(response, req)
		return response
	}
	productBody := `{"type":"reward","name":"一起看电影","asset_key":"reward-gift-v1","description":"家庭奖励","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`
	response := request("POST", "/api/v1/management/products", productBody, "product-test")
	if response.Code != 403 {
		t.Fatalf("locked configuration accepted: %d %s", response.Code, response.Body)
	}
	if response = apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF); response.Code != 200 {
		t.Fatalf("unlock: %d %s", response.Code, response.Body)
	}
	response = request("POST", "/api/v1/management/products", productBody, "product-test")
	if response.Code != 201 {
		t.Fatalf("create: %d %s", response.Code, response.Body)
	}
	var product shop.Product
	if err := json.Unmarshal(response.Body.Bytes(), &product); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(response.Body.String(), `"stock":null`) || product.Owned {
		t.Fatalf("product wire: %s", response.Body)
	}
	purchaseBody := `{"product_id":"` + product.ID + `","expected_product_version":1,"expected_wallet_version":1}`
	response = request("POST", "/api/v1/purchases", purchaseBody, "purchase-test")
	if response.Code != 201 {
		t.Fatalf("purchase: %d %s", response.Code, response.Body)
	}
	var first shop.PurchaseResult
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	response = request("POST", "/api/v1/purchases", purchaseBody, "purchase-test")
	var replay shop.PurchaseResult
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &replay) != nil || replay.Purchase.ID != first.Purchase.ID {
		t.Fatalf("replay: %d %s", response.Code, response.Body)
	}
	response = request("POST", "/api/v1/purchases", strings.TrimSuffix(purchaseBody, "}")+`,"coin_price":0}`, "new-key")
	if response.Code != 400 {
		t.Fatalf("unknown economic field accepted: %d %s", response.Code, response.Body)
	}
	response = request("GET", "/api/v1/purchases?limit=0", "", "")
	if response.Code != 400 {
		t.Fatalf("explicit zero page limit accepted: %d %s", response.Code, response.Body)
	}
	response = request("POST", "/api/v1/purchases/"+first.Purchase.ID+"/redeem", `{"password":"wrong-password"}`, "")
	if response.Code != 422 {
		t.Fatalf("bad redemption password must preserve session: %d %s", response.Code, response.Body)
	}
	response = request("POST", "/api/v1/purchases/"+first.Purchase.ID+"/redeem", `{"password":"manage-password"}`, "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"status":"redeemed"`) {
		t.Fatalf("redeem: %d %s", response.Code, response.Body)
	}
	response = request("PUT", "/api/v1/equipment/avatar", `{}`, "")
	if response.Code != 400 {
		t.Fatalf("missing slot value cleared equipment: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, http.MethodGet, "/api/v1/products", "", nil, "")
	if response.Code != 401 {
		t.Fatalf("public shop accepted: %d", response.Code)
	}
}
