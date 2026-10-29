package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestAccessoryLayoutHTTP verifies required nullable ordering intent and persisted numeric JSON.
func TestAccessoryLayoutHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	created := request("POST", "/api/v1/management/products", `{"type":"accessory","name":"星星","asset_key":"accessory-star-v1","description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, "create-accessory")
	var product shop.Product
	if created.Code != 201 || json.Unmarshal(created.Body.Bytes(), &product) != nil {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	bought := request("POST", "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":1}`, product.ID), "buy-accessory")
	var purchased shop.PurchaseResult
	if bought.Code != 201 || json.Unmarshal(bought.Body.Bytes(), &purchased) != nil {
		t.Fatalf("buy: %d %s", bought.Code, bought.Body)
	}
	path := "/api/v1/equipment/accessories/" + purchased.Purchase.ID
	if result := request("PUT", path, "", ""); result.Code != 200 {
		t.Fatalf("equip: %d %s", result.Code, result.Body)
	}
	for _, body := range []string{
		`{"x":0.5,"y":0.5,"size":0.2}`,
		`{"x":0.5,"y":0.5,"size":null,"before_id":null}`,
		`{"x":"0.5","y":0.5,"size":0.2,"before_id":null}`,
		`{"x":0.5,"y":0.5,"size":0.2,"before_id":null,"layer":3}`,
		`{"x":0,"y":0.5,"size":0.2,"before_id":null}`,
	} {
		if result := request("PATCH", path+"/layout", body, ""); result.Code != 400 {
			t.Fatalf("invalid body accepted: %s %d %s", body, result.Code, result.Body)
		}
	}
	for _, before := range []string{`"avatar"`, `null`} {
		result := request("PATCH", path+"/layout", `{"x":0.4,"y":0.6,"size":0.3,"before_id":`+before+`}`, "")
		var equipment shop.Equipment
		if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &equipment) != nil {
			t.Fatalf("save: %d %s", result.Code, result.Body)
		}
		layout := equipment.AccessoryLayouts[purchased.Purchase.ID]
		if layout.X != .4 || layout.Y != .6 || layout.Size != .3 || (before == `"avatar"` && layout.Layer != -1) || (before == "null" && layout.Layer != 1) {
			t.Fatalf("layout: %+v", layout)
		}
		if !strings.Contains(result.Body.String(), `"background":null`) || !strings.Contains(result.Body.String(), `"effects":[]`) {
			t.Fatalf("new slots have incorrect JSON shape: %s", result.Body)
		}
	}
	if removed := request("DELETE", path, "", ""); removed.Code != 200 {
		t.Fatal(removed.Body)
	}
	if result := request("PATCH", path+"/layout", `{"x":0.4,"y":0.6,"size":0.3,"before_id":null}`, ""); result.Code != 409 || !strings.Contains(result.Body.String(), `"code":"EQUIPMENT_CHANGED"`) {
		t.Fatalf("stale save: %d %s", result.Code, result.Body)
	}
	if result := apiRequest(app, "PATCH", path+"/layout", `{"x":0.4,"y":0.6,"size":0.3,"before_id":null}`, nil, ""); result.Code != 401 {
		t.Fatalf("anonymous save accepted: %d", result.Code)
	}
}

// TestBackgroundAndEffectHTTP covers the same permanent-purchase protocol and independent equipment routes.
func TestBackgroundAndEffectHTTP(t *testing.T) {
	_, request := shopHTTPRequest(t)
	walletVersion := 1
	for _, kind := range []string{"background", "effect"} {
		assetKey := "background-meadow-v1"
		if kind == "effect" {
			assetKey = "effect-snow-v1"
		}
		created := request("POST", "/api/v1/management/products", fmt.Sprintf(`{"type":%q,"name":"装扮","asset_key":%q,"description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, kind, assetKey), "create-"+kind)
		var product shop.Product
		if created.Code != 201 || json.Unmarshal(created.Body.Bytes(), &product) != nil {
			t.Fatalf("create %s: %d %s", kind, created.Code, created.Body)
		}
		bought := request("POST", "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":%d}`, product.ID, walletVersion), "buy-"+kind)
		walletVersion++
		var purchase shop.PurchaseResult
		if bought.Code != 201 || json.Unmarshal(bought.Body.Bytes(), &purchase) != nil {
			t.Fatalf("buy %s: %d %s", kind, bought.Code, bought.Body)
		}
		if kind == "background" {
			result := request("PUT", "/api/v1/equipment/background", fmt.Sprintf(`{"purchase_id":%q}`, purchase.Purchase.ID), "")
			var equipment shop.Equipment
			if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &equipment) != nil || equipment.Background == nil || equipment.Background.ID != purchase.Purchase.ID {
				t.Fatalf("background: %d %s", result.Code, result.Body)
			}
		} else {
			path := "/api/v1/equipment/effects/" + purchase.Purchase.ID
			for _, method := range []string{"PUT", "PUT", "DELETE", "DELETE"} {
				result := request(method, path, "", "")
				var state shop.AccessoryResult
				if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &state) != nil || state.Equipped != (method == "PUT") {
					t.Fatalf("effect: %d %s", result.Code, result.Body)
				}
			}
		}
	}
}
