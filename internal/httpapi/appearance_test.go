package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// appearanceHTTPState reads the wire contract without substituting service return values.
type appearanceHTTPState struct {
	Version         int64   `json:"version"`           // 独立外观版本。
	CharacterKey    string  `json:"character_key"`     // 当前身体定义。
	HairPurchaseID  *string `json:"hair_purchase_id"`  // 空值恢复默认发型。
	UpperPurchaseID *string `json:"upper_purchase_id"` // 已拥有上衣实例。
	LowerPurchaseID *string `json:"lower_purchase_id"` // 已拥有下装实例。
	ShoesPurchaseID *string `json:"shoes_purchase_id"` // 已拥有鞋子实例。
	Characters      []struct {
		Key      string `json:"character_key"` // 目录人物身份。
		Defaults struct {
			Upper string `json:"upper"` // 免费上衣定义。
		} `json:"defaults"` // 免费默认装束。
	} `json:"characters"` // 已安装人物目录。
	Wearables []struct {
		Key          string `json:"wearable_key"`        // 稳定服装定义。
		Slot         string `json:"slot"`                // 新四槽部位。
		ThumbnailKey string `json:"thumbnail_asset_key"` // 商品展示图片。
	} `json:"wearables"` // 可用服装目录。
	Inventory []struct {
		PurchaseID  string `json:"purchase_id"`  // 已拥有购买实例。
		WearableKey string `json:"wearable_key"` // 成交服装定义。
	} `json:"inventory"` // 不受订单分页限制的服装库存。
}

// appearanceHTTPRequest submits all four slots; omission has a different meaning from null.
func appearanceHTTPRequest(version int64, character string) map[string]any {
	return map[string]any{"expected_version": version, "character_key": character, "hair_purchase_id": nil, "upper_purchase_id": nil, "lower_purchase_id": nil, "shoes_purchase_id": nil}
}

// appearanceHTTPBody preserves explicit nulls in the actual serialized request.
func appearanceHTTPBody(t *testing.T, input map[string]any) string {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// TestAppearanceHTTPRequiredFieldsAndAuthorization checks the HTTP boundary on a real database.
func TestAppearanceHTTPRequiredFieldsAndAuthorization(t *testing.T) {
	app, request := shopHTTPRequest(t)
	if response := apiRequest(app, http.MethodGet, "/api/v1/appearance", "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous read: %d %s", response.Code, response.Body)
	}
	initialResponse := request(http.MethodGet, "/api/v1/appearance", "", "")
	var initial appearanceHTTPState
	if initialResponse.Code != http.StatusOK || json.Unmarshal(initialResponse.Body.Bytes(), &initial) != nil || initial.Version != 1 || initial.CharacterKey == "" || len(initial.Characters) == 0 || len(initial.Wearables) == 0 {
		t.Fatalf("initial appearance: %d %s", initialResponse.Code, initialResponse.Body)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"hair_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id"} {
		if string(fields[field]) != "null" {
			t.Fatalf("default %s must be explicit null: %s", field, initialResponse.Body)
		}
	}
	if string(fields["inventory"]) != "[]" {
		t.Fatalf("empty inventory must be an array: %s", initialResponse.Body)
	}
	for _, field := range []string{"expected_version", "character_key", "hair_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		delete(body, field)
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), field) || !strings.Contains(response.Body.String(), "REQUIRED") {
			t.Fatalf("missing %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, field := range []string{"character_key", "hair_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		body[field] = ""
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("empty %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, invalid := range []string{
		`null`, `[]`, `{"expected_version":null,"character_key":"x","hair_purchase_id":null,"upper_purchase_id":null,"lower_purchase_id":null,"shoes_purchase_id":null}`,
		strings.TrimSuffix(appearanceHTTPBody(t, appearanceHTTPRequest(initial.Version, initial.CharacterKey)), "}") + `,"unknown":true}`,
	} {
		if response := request(http.MethodPut, "/api/v1/appearance", invalid, ""); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body accepted: %s => %d %s", invalid, response.Code, response.Body)
		}
	}
	body := appearanceHTTPBody(t, appearanceHTTPRequest(initial.Version, initial.CharacterKey))
	if response := apiRequest(app, http.MethodPut, "/api/v1/appearance", body, nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous save: %d %s", response.Code, response.Body)
	}
	login := apiRequest(app, http.MethodPost, "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != http.StatusOK {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	if response := apiRequest(app, http.MethodPut, "/api/v1/appearance", body, login.Result().Cookies()[0], ""); response.Code != http.StatusForbidden {
		t.Fatalf("save without csrf: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodPost, "/api/v1/management/lock", "", ""); response.Code != http.StatusNoContent {
		t.Fatalf("lock management: %d %s", response.Code, response.Body)
	}
	saved := request(http.MethodPut, "/api/v1/appearance", body, "")
	var result appearanceHTTPState
	if saved.Code != http.StatusOK || json.Unmarshal(saved.Body.Bytes(), &result) != nil || result.Version != initial.Version+1 {
		t.Fatalf("save explicit defaults without management: %d %s", saved.Code, saved.Body)
	}
	if response := request(http.MethodPut, "/api/v1/appearance", body, ""); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "VERSION_CONFLICT") {
		t.Fatalf("stale appearance accepted: %d %s", response.Code, response.Body)
	}
}

// TestAppearanceHTTPOwnedWearable keeps purchase facts and all-or-nothing slot writes visible on the wire.
func TestAppearanceHTTPOwnedWearable(t *testing.T) {
	_, request := shopHTTPRequest(t)
	initialResponse := request(http.MethodGet, "/api/v1/appearance", "", "")
	var initial appearanceHTTPState
	if initialResponse.Code != http.StatusOK || json.Unmarshal(initialResponse.Body.Bytes(), &initial) != nil || len(initial.Characters) == 0 {
		t.Fatalf("initial: %d %s", initialResponse.Code, initialResponse.Body)
	}
	var wearableKey, thumbnailKey string
	for _, item := range initial.Wearables {
		if item.Slot == "upper" && item.Key != initial.Characters[0].Defaults.Upper {
			wearableKey, thumbnailKey = item.Key, item.ThumbnailKey
			break
		}
	}
	if wearableKey == "" {
		t.Fatal("fixture has no purchasable upper garment")
	}
	created := request(http.MethodPost, "/api/v1/management/products", fmt.Sprintf(`{"type":"wearable","name":"上衣","asset_key":%q,"wearable_key":%q,"description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, thumbnailKey, wearableKey), "appearance-create-upper")
	var product struct {
		ID          string `json:"id"`           // 当前商品身份。
		WearableKey string `json:"wearable_key"` // 商品的稳定服装定义。
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &product) != nil || product.WearableKey != wearableKey {
		t.Fatalf("create upper: %d %s", created.Code, created.Body)
	}
	bought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":1}`, product.ID), "appearance-buy-upper")
	var purchase struct {
		Purchase struct {
			ID          string `json:"id"`           // 已拥有的购买实例。
			WearableKey string `json:"wearable_key"` // 不随商品删除而变化的定义。
		} `json:"purchase"` // 购买成功结果。
	}
	if bought.Code != http.StatusCreated || json.Unmarshal(bought.Body.Bytes(), &purchase) != nil || purchase.Purchase.WearableKey != wearableKey {
		t.Fatalf("buy upper: %d %s", bought.Code, bought.Body)
	}
	body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
	body["upper_purchase_id"] = purchase.Purchase.ID
	saved := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
	var state appearanceHTTPState
	if saved.Code != http.StatusOK || json.Unmarshal(saved.Body.Bytes(), &state) != nil || state.UpperPurchaseID == nil || *state.UpperPurchaseID != purchase.Purchase.ID || len(state.Inventory) != 1 || state.Inventory[0].WearableKey != wearableKey {
		t.Fatalf("owned upper: %d %s", saved.Code, saved.Body)
	}
	invalid := appearanceHTTPRequest(state.Version, initial.CharacterKey)
	invalid["hair_purchase_id"] = purchase.Purchase.ID
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong slot accepted: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodPut, "/api/v1/equipment/top", fmt.Sprintf(`{"purchase_id":%q}`, purchase.Purchase.ID), ""); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("3d garment accepted by legacy 2d slot: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodDelete, "/api/v1/management/products/"+product.ID, `{"expected_version":1}`, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete product: %d %s", response.Code, response.Body)
	}
	body["expected_version"] = state.Version
	response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
	var afterDelete appearanceHTTPState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &afterDelete) != nil || afterDelete.Version != state.Version+1 || afterDelete.UpperPurchaseID == nil || *afterDelete.UpperPurchaseID != purchase.Purchase.ID {
		t.Fatalf("deleted product lost owned garment or invalid save changed revision: %d %s", response.Code, response.Body)
	}
	oldCreated := request(http.MethodPost, "/api/v1/management/products", `{"type":"accessory","name":"旧饰品","asset_key":"accessory-star-v1","description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, "appearance-create-2d")
	var oldProduct struct {
		ID string `json:"id"` // 旧二维商品。
	}
	if oldCreated.Code != http.StatusCreated || json.Unmarshal(oldCreated.Body.Bytes(), &oldProduct) != nil {
		t.Fatalf("create old accessory: %d %s", oldCreated.Code, oldCreated.Body)
	}
	oldBought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":2}`, oldProduct.ID), "appearance-buy-2d")
	var oldPurchase struct {
		Purchase struct {
			ID string `json:"id"` // 旧二维购买实例。
		} `json:"purchase"` // 旧饰品购买结果。
	}
	if oldBought.Code != http.StatusCreated || json.Unmarshal(oldBought.Body.Bytes(), &oldPurchase) != nil {
		t.Fatalf("buy old accessory: %d %s", oldBought.Code, oldBought.Body)
	}
	invalid = appearanceHTTPRequest(afterDelete.Version, initial.CharacterKey)
	invalid["hair_purchase_id"] = oldPurchase.Purchase.ID
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("2d purchase accepted by 3d appearance: %d %s", response.Code, response.Body)
	}
}
