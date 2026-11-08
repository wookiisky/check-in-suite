package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 称号只通过独立入口保存，响应不再夹带已退出的二维装备字段。
func TestTitleHTTPRequiresOwnedPurchaseAndExplicitNull(t *testing.T) {
	app, request := shopHTTPRequest(t)
	const productID = "historical-growth-title"
	seedHistoricalOfferHTTP(t, app, productID, shop.TypeTitle, "成长称号", "title-crown-v1")
	bought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":1}`, productID), "title-buy")
	var purchase shop.PurchaseResult
	if bought.Code != http.StatusCreated || json.Unmarshal(bought.Body.Bytes(), &purchase) != nil {
		t.Fatalf("buy=%d %s", bought.Code, bought.Body)
	}
	for _, body := range []string{`{}`, `{"purchase_id":""}`, `{"purchase_id":null,"slot":"title"}`} {
		response := request(http.MethodPut, "/api/v1/equipment/title", body, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted %s: %d %s", body, response.Code, response.Body)
		}
	}
	saved := request(http.MethodPut, "/api/v1/equipment/title", fmt.Sprintf(`{"purchase_id":%q}`, purchase.Purchase.ID), "")
	var equipment shop.Equipment
	if saved.Code != http.StatusOK || json.Unmarshal(saved.Body.Bytes(), &equipment) != nil || equipment.Title == nil || equipment.Title.ID != purchase.Purchase.ID {
		t.Fatalf("save=%d %s", saved.Code, saved.Body)
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(saved.Body.Bytes(), &shape) != nil || len(shape) != 1 || shape["title"] == nil {
		t.Fatalf("unexpected equipment fields: %s", saved.Body)
	}
	cleared := request(http.MethodPut, "/api/v1/equipment/title", `{"purchase_id":null}`, "")
	if cleared.Code != http.StatusOK || json.Unmarshal(cleared.Body.Bytes(), &shape) != nil || string(shape["title"]) != "null" {
		t.Fatalf("clear=%d %s", cleared.Code, cleared.Body)
	}
	if response := apiRequest(app, http.MethodPut, "/api/v1/equipment/title", `{"purchase_id":null}`, nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous write=%d", response.Code)
	}
}

// 已退出的类型和接口不再保留兼容写入路径。
func TestRetiredEquipmentHTTPDoesNotRemainWritable(t *testing.T) {
	_, request := shopHTTPRequest(t)
	for _, kind := range []string{"avatar", "background", "effect", "accessory"} {
		response := request(http.MethodPost, "/api/v1/management/products", fmt.Sprintf(`{"type":%q,"name":"旧类型","asset_key":"title-crown-v1","description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, kind), "retired-"+kind)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted type %s: %d %s", kind, response.Code, response.Body)
		}
	}
	for _, path := range []string{"/api/v1/equipment/base-avatar", "/api/v1/equipment/hair", "/api/v1/equipment/accessories/purchase", "/api/v1/equipment/effects/purchase"} {
		response := request(http.MethodPut, path, `{"purchase_id":null}`, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("retired route %s: %d %s", path, response.Code, response.Body)
		}
	}
}
