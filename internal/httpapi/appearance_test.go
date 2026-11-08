package httpapi

import (
	"encoding/json"
	"fmt"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"net/http"
	"strings"
	"testing"
)

// appearanceHTTPState reads the wire contract without substituting service return values.
type appearanceHTTPState struct {
	FacePurchaseID  *string `json:"face_purchase_id"`  // 形象实例。
	BackPurchaseID  *string `json:"back_purchase_id"`  // 背部实例。
	Version         int64   `json:"version"`           // 独立外观版本。
	CharacterKey    string  `json:"character_key"`     // 当前身体定义。
	HeadPurchaseID  *string `json:"head_purchase_id"`  // 空值恢复默认发型。
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
		Empty        bool   `json:"empty"`               // 无穿戴默认定义，不是可购买商品。
		Key          string `json:"wearable_key"`        // 稳定服装定义。
		Slot         string `json:"slot"`                // 六槽部位。
		ThumbnailKey string `json:"thumbnail_asset_key"` // 商品展示图片。
	} `json:"wearables"` // 可用服装目录。
	Inventory []struct {
		PurchaseID  string `json:"purchase_id"`  // 已拥有购买实例。
		WearableKey string `json:"wearable_key"` // 成交服装定义。
	} `json:"inventory"` // 不受订单分页限制的服装库存。
}

// appearanceHTTPRequest submits all six slots; omission has a different meaning from null.
func appearanceHTTPRequest(version int64, character string) map[string]any {
	return map[string]any{"expected_version": version, "character_key": character, "face_purchase_id": nil, "back_purchase_id": nil, "head_purchase_id": nil, "upper_purchase_id": nil, "lower_purchase_id": nil, "shoes_purchase_id": nil}
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

// 配色随外观整套保存，缺省或 null 恢复素材底色。
func TestAppearanceHTTPColorPresets(t *testing.T) {
	_, request := shopHTTPRequest(t)
	const path = "/api/v1/appearance"
	read := func() map[string]json.RawMessage {
		t.Helper()
		response := request(http.MethodGet, path, "", "")
		var state map[string]json.RawMessage
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil {
			t.Fatalf("read appearance: %d %s", response.Code, response.Body)
		}
		return state
	}
	initial := read()
	var palette []struct {
		Key  string `json:"key"`  // 预设身份。
		Name string `json:"name"` // 界面色名。
		Hex  string `json:"hex"`  // 供渲染器与色块使用的 sRGB 色值。
	}
	if err := json.Unmarshal(initial["wearable_colors"], &palette); err != nil || len(palette) != 8 {
		t.Fatalf("palette = %s, %v", initial["wearable_colors"], err)
	}
	seen := make(map[string]bool, len(palette))
	for _, color := range palette {
		if color.Key == "" || color.Name == "" || len(color.Hex) != 7 || color.Hex[0] != '#' || seen[color.Key] {
			t.Fatalf("invalid wire color: %+v", color)
		}
		seen[color.Key] = true
	}
	if string(initial["upper_color_key"]) != "null" || string(initial["back_color_key"]) != "null" {
		t.Fatalf("initial colors = %s, %s", initial["upper_color_key"], initial["back_color_key"])
	}
	body := appearanceHTTPRequest(1, character.DefaultCharacterKey)
	for _, scenario := range []struct {
		field string // 请求字段。
		value any    // 应拒绝的值。
		code  int    // 预期 HTTP 状态。
	}{
		{"upper_color_key", "#00FF00", http.StatusBadRequest},
		{"upper_color_key", "", http.StatusBadRequest},
		{"back_color_key", "blue", http.StatusUnprocessableEntity},
	} {
		body[scenario.field] = scenario.value
		response := request(http.MethodPut, path, appearanceHTTPBody(t, body), "")
		if response.Code != scenario.code {
			t.Fatalf("invalid %s = %v: %d %s", scenario.field, scenario.value, response.Code, response.Body)
		}
		delete(body, scenario.field)
	}
	body["upper_color_key"] = "blue"
	if response := request(http.MethodPut, path, appearanceHTTPBody(t, body), ""); response.Code != http.StatusOK {
		t.Fatalf("save default vest color: %d %s", response.Code, response.Body)
	}
	if state := read(); string(state["version"]) != "2" || string(state["upper_color_key"]) != `"blue"` || string(state["upper_purchase_id"]) != "null" {
		t.Fatalf("color-only save = %s %s %s", state["version"], state["upper_color_key"], state["upper_purchase_id"])
	}
	body["upper_color_key"] = "green"
	if response := request(http.MethodPut, path, appearanceHTTPBody(t, body), ""); response.Code != http.StatusConflict {
		t.Fatalf("stale color save: %d %s", response.Code, response.Body)
	}
	if state := read(); string(state["upper_color_key"]) != `"blue"` {
		t.Fatalf("stale request replaced color: %s", state["upper_color_key"])
	}
	body["expected_version"] = 2
	body["upper_color_key"] = nil
	if response := request(http.MethodPut, path, appearanceHTTPBody(t, body), ""); response.Code != http.StatusOK {
		t.Fatalf("restore color: %d %s", response.Code, response.Body)
	}
	if state := read(); string(state["upper_color_key"]) != "null" {
		t.Fatalf("restored color = %s", state["upper_color_key"])
	}
	body["expected_version"] = 3
	body["upper_color_key"] = "green"
	if response := request(http.MethodPut, path, appearanceHTTPBody(t, body), ""); response.Code != http.StatusOK {
		t.Fatalf("save color before legacy write: %d %s", response.Code, response.Body)
	}
	legacy := appearanceHTTPRequest(4, character.DefaultCharacterKey)
	if response := request(http.MethodPut, path, appearanceHTTPBody(t, legacy), ""); response.Code != http.StatusOK {
		t.Fatalf("legacy write without colors: %d %s", response.Code, response.Body)
	}
	if state := read(); string(state["upper_color_key"]) != "null" {
		t.Fatalf("legacy write restored color = %s", state["upper_color_key"])
	}
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
	for _, field := range []string{"face_purchase_id", "head_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id", "back_purchase_id"} {
		if string(fields[field]) != "null" {
			t.Fatalf("default %s must be explicit null: %s", field, initialResponse.Body)
		}
	}
	if string(fields["inventory"]) != "[]" {
		t.Fatalf("empty inventory must be an array: %s", initialResponse.Body)
	}
	for _, field := range []string{"expected_version", "character_key", "face_purchase_id", "head_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id", "back_purchase_id"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		delete(body, field)
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), field) || !strings.Contains(response.Body.String(), "REQUIRED") {
			t.Fatalf("missing %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, field := range []string{"character_key", "face_purchase_id", "head_purchase_id", "upper_purchase_id", "lower_purchase_id", "shoes_purchase_id", "back_purchase_id"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		body[field] = ""
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("empty %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, invalid := range []string{
		`null`, `[]`, `{"expected_version":null,"character_key":"x","head_purchase_id":null,"upper_purchase_id":null,"lower_purchase_id":null,"shoes_purchase_id":null}`,
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
	defaults := map[string]bool{}
	for _, body := range initial.Characters {
		defaults[body.Defaults.Upper] = true
	}
	for _, item := range initial.Wearables {
		if item.Slot == "upper" && !item.Empty && !defaults[item.Key] {
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
	invalid["head_purchase_id"] = purchase.Purchase.ID
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong slot accepted: %d %s", response.Code, response.Body)
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
	titleCreated := request(http.MethodPost, "/api/v1/management/products", `{"type":"title","name":"称号","asset_key":"title-crown-v1","description":"","coin_price":0,"diamond_price":0,"stock":null,"enabled":true}`, "appearance-create-title")
	var titleProduct struct {
		ID string `json:"id"` // 称号商品。
	}
	if titleCreated.Code != http.StatusCreated || json.Unmarshal(titleCreated.Body.Bytes(), &titleProduct) != nil {
		t.Fatalf("create non-wearable title: %d %s", titleCreated.Code, titleCreated.Body)
	}
	titleBought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":2}`, titleProduct.ID), "appearance-buy-title")
	var titlePurchase struct {
		Purchase struct {
			ID string `json:"id"` // 称号购买实例。
		} `json:"purchase"` // 称号购买结果。
	}
	if titleBought.Code != http.StatusCreated || json.Unmarshal(titleBought.Body.Bytes(), &titlePurchase) != nil {
		t.Fatalf("buy title: %d %s", titleBought.Code, titleBought.Body)
	}
	invalid = appearanceHTTPRequest(afterDelete.Version, initial.CharacterKey)
	invalid["head_purchase_id"] = titlePurchase.Purchase.ID
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("title purchase accepted by character appearance: %d %s", response.Code, response.Body)
	}
}

// 实际HTTP购买与整套保存分别保留形象、头部和背部，且各字段缺省与错误槽位均被拒绝。
func TestAppearanceHTTPSixSlotOwnedSelections(t *testing.T) {
	_, request := shopHTTPRequest(t)
	initialResponse := request(http.MethodGet, "/api/v1/appearance", "", "")
	var initial shop.AppearanceState
	if initialResponse.Code != http.StatusOK || json.Unmarshal(initialResponse.Body.Bytes(), &initial) != nil {
		t.Fatalf("initial: %d %s", initialResponse.Code, initialResponse.Body)
	}
	defaults := map[string]bool{}
	for _, body := range initial.Characters {
		for _, slot := range character.Slots() {
			defaults[body.Defaults.ForSlot(slot)] = true
		}
	}
	command := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
	walletVersion := int64(1)
	for _, slot := range []character.Slot{character.SlotFace, character.SlotHead, character.SlotBack} {
		var wearable character.Wearable
		for _, candidate := range initial.Wearables {
			if candidate.Slot == slot && !candidate.Empty && !defaults[candidate.Key] {
				wearable = candidate
				break
			}
		}
		if wearable.Key == "" {
			t.Fatalf("no independent %s product", slot)
		}
		input := shop.ProductInput{Type: shop.TypeWearable, Name: wearable.Name, AssetKey: wearable.ThumbnailAssetKey, WearableKey: wearable.Key, Enabled: true}
		payload, _ := json.Marshal(input)
		response := request(http.MethodPost, "/api/v1/management/products", string(payload), "six-slot-create-"+string(slot))
		var product shop.Product
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &product) != nil {
			t.Fatalf("create: %d %s", response.Code, response.Body)
		}
		payload, _ = json.Marshal(shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: walletVersion})
		response = request(http.MethodPost, "/api/v1/purchases", string(payload), "six-slot-buy-"+string(slot))
		var purchase shop.PurchaseResult
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &purchase) != nil {
			t.Fatalf("purchase: %d %s", response.Code, response.Body)
		}
		command[string(slot)+"_purchase_id"] = purchase.Purchase.ID
		walletVersion = purchase.Wallet.Version
	}
	response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, command), "")
	var saved shop.AppearanceState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.FacePurchaseID == nil || saved.HeadPurchaseID == nil || saved.BackPurchaseID == nil || len(saved.Inventory) != 3 {
		t.Fatalf("six slots: %d %s", response.Code, response.Body)
	}
	invalid := appearanceHTTPRequest(saved.Version, saved.CharacterKey)
	invalid["face_purchase_id"] = *saved.BackPurchaseID
	response = request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), "")
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong slot: %d %s", response.Code, response.Body)
	}
	response = request(http.MethodGet, "/api/v1/appearance", "", "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Version != 2 {
		t.Fatalf("failed save was committed: %d %s", response.Code, response.Body)
	}
}
