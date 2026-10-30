package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestFixedWearableHTTP verifies the public slot contract and blocks the movable-accessory routes.
func TestFixedWearableHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	for _, invalid := range []string{`{}`, `{"asset_key":null}`, `{"asset_key":"avatar-boy-v2","x":0.5}`, `{"asset_key":"fox-v1"}`} {
		response := request("PUT", "/api/v1/equipment/base-avatar", invalid, "")
		if response.Code != 400 {
			t.Fatalf("invalid base body accepted: %s: %d %s", invalid, response.Code, response.Body)
		}
	}
	response := request("PUT", "/api/v1/equipment/base-avatar", `{"asset_key":"avatar-girl-v2"}`, "")
	var equipment shop.Equipment
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &equipment) != nil || equipment.BaseAvatarKey != "avatar-girl-v2" || equipment.Avatar != nil {
		t.Fatalf("select base: %d %s", response.Code, response.Body)
	}
	var shape map[string]any
	if json.Unmarshal(response.Body.Bytes(), &shape) != nil {
		t.Fatal("invalid equipment JSON")
	}
	wearables, ok := shape["wearables"].(map[string]any)
	if !ok || len(wearables) != 4 {
		t.Fatalf("wearable JSON must contain four nullable slots: %s", response.Body)
	}
	for _, slot := range []string{"hair", "top", "bottom", "shoes"} {
		if value, exists := wearables[slot]; !exists || value != nil {
			t.Fatalf("missing empty slot %s: %+v", slot, wearables)
		}
	}
	created := request("POST", "/api/v1/management/products", `{"type":"accessory","name":"卷发","asset_key":"hair-curly-v1","description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, "create-hair")
	var product shop.Product
	if created.Code != 201 || json.Unmarshal(created.Body.Bytes(), &product) != nil || product.WearableSlot != "hair" {
		t.Fatalf("create hair: %d %s", created.Code, created.Body)
	}
	bought := request("POST", "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":1}`, product.ID), "buy-hair")
	var purchase shop.PurchaseResult
	if bought.Code != 201 || json.Unmarshal(bought.Body.Bytes(), &purchase) != nil {
		t.Fatalf("buy hair: %d %s", bought.Code, bought.Body)
	}
	response = request("PUT", "/api/v1/equipment/hair", fmt.Sprintf(`{"purchase_id":%q}`, purchase.Purchase.ID), "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &equipment) != nil || equipment.Wearables.Hair == nil || equipment.Wearables.Hair.ID != purchase.Purchase.ID {
		t.Fatalf("equip hair: %d %s", response.Code, response.Body)
	}
	path := "/api/v1/equipment/accessories/" + purchase.Purchase.ID
	if response := request("PUT", path, "", ""); response.Code != 422 {
		t.Fatalf("hair equipped as movable decoration: %d %s", response.Code, response.Body)
	}
	if response := request("PATCH", path+"/layout", `{"x":0.5,"y":0.5,"size":0.2,"rotation":0,"before_id":null}`, ""); response.Code != 422 {
		t.Fatalf("hair layout changed: %d %s", response.Code, response.Body)
	}
	for _, invalid := range []string{`{}`, `{"purchase_id":null,"x":0.5}`} {
		if response := request("PUT", "/api/v1/equipment/hair", invalid, ""); response.Code != 400 {
			t.Fatalf("invalid wearable body: %d %s", response.Code, response.Body)
		}
	}
	if response := request("PUT", "/api/v1/equipment/hair", `{"purchase_id":null}`, ""); response.Code != 200 {
		t.Fatalf("unequip: %d %s", response.Code, response.Body)
	}
	if response := apiRequest(app, "PUT", "/api/v1/equipment/base-avatar", `{"asset_key":"avatar-boy-v2"}`, nil, ""); response.Code != 401 {
		t.Fatalf("anonymous base switch: %d", response.Code)
	}
}
