package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// appearanceHTTPState reads the wire contract without substituting service return values.
type appearanceHTTPState struct {
	FaceWearableKey  *string `json:"face_wearable_key"`  // 形象实例。
	BackWearableKey  *string `json:"back_wearable_key"`  // 背部实例。
	Version          int64   `json:"version"`            // 独立外观版本。
	CharacterKey     string  `json:"character_key"`      // 当前身体定义。
	HeadWearableKey  *string `json:"head_wearable_key"`  // 空值恢复默认发型。
	UpperWearableKey *string `json:"upper_wearable_key"` // 已拥有上衣实例。
	LowerWearableKey *string `json:"lower_wearable_key"` // 已拥有下装实例。
	ShoesWearableKey *string `json:"shoes_wearable_key"` // 已拥有鞋子实例。
	Characters       []struct {
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
		WearableKey string `json:"wearable_key"` // 成交服装定义。
	} `json:"inventory"` // 不受订单分页限制的服装库存。
}

// appearanceHTTPRequest submits all six slots; omission has a different meaning from null.
func appearanceHTTPRequest(version int64, character string) map[string]any {
	return map[string]any{"expected_version": version, "character_key": character, "face_wearable_key": nil, "back_wearable_key": nil, "head_wearable_key": nil, "upper_wearable_key": nil, "lower_wearable_key": nil, "shoes_wearable_key": nil}
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

// appearanceCatalogQuote 通过正式目录补入报价，再用管理接口设为零价。
func appearanceCatalogQuote(t *testing.T, app *App, request func(string, string, string, string) *httptest.ResponseRecorder, key, kind string) shop.Product {
	t.Helper()
	seed := shop.SeedWearableProducts
	if kind == shop.TypeCharacter {
		seed = shop.SeedCharacterProducts
	}
	if err := seed(context.Background(), app.DB, 1); err != nil {
		t.Fatal(err)
	}
	response := request(http.MethodGet, "/api/v1/products?include_inactive=true", "", "")
	var list shop.ProductList
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &list) != nil {
		t.Fatalf("list %s: %d %s", kind, response.Code, response.Body)
	}
	for _, product := range list.Items {
		if product.Type != kind || product.WearableKey != key && product.CharacterKey != key {
			continue
		}
		input := shop.ProductUpdate{ExpectedVersion: product.Version, ProductTerms: shop.ProductTerms{Name: product.Name, Enabled: true}}
		payload, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		response = request(http.MethodPatch, "/api/v1/management/products/"+product.ID, string(payload), "")
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &product) != nil {
			t.Fatalf("configure %s: %d %s", key, response.Code, response.Body)
		}
		return product
	}
	t.Fatalf("missing catalog quote %s", key)
	return shop.Product{}
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
	if err := json.Unmarshal(initial["wearable_colors"], &palette); err != nil || len(palette) != 10 {
		t.Fatalf("palette = %s, %v", initial["wearable_colors"], err)
	}
	seen := make(map[string]bool, len(palette))
	for _, color := range palette {
		if color.Key == "" || color.Name == "" || len(color.Hex) != 7 || color.Hex[0] != '#' || seen[color.Key] {
			t.Fatalf("invalid wire color: %+v", color)
		}
		seen[color.Key] = true
	}
	if !seen["gray"] || !seen["purple"] {
		t.Fatalf("missing gray or purple: %s", initial["wearable_colors"])
	}
	for _, field := range []string{"head_color_key", "upper_color_key", "lower_color_key", "shoes_color_key", "back_color_key"} {
		if string(initial[field]) != "null" {
			t.Fatalf("initial %s = %s", field, initial[field])
		}
	}
	body := appearanceHTTPRequest(1, character.DefaultCharacterKey)
	for _, scenario := range []struct {
		field string // 请求字段。
		value any    // 应拒绝的值。
		code  int    // 预期 HTTP 状态。
	}{
		{"upper_color_key", "#00FF00", http.StatusBadRequest},
		{"upper_color_key", "", http.StatusBadRequest},
		{"head_color_key", "blue", http.StatusUnprocessableEntity},
		{"lower_color_key", "blue", http.StatusUnprocessableEntity},
		{"shoes_color_key", "blue", http.StatusUnprocessableEntity},
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
	if state := read(); string(state["version"]) != "2" || string(state["upper_color_key"]) != `"blue"` || string(state["upper_wearable_key"]) != "null" {
		t.Fatalf("color-only save = %s %s %s", state["version"], state["upper_color_key"], state["upper_wearable_key"])
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

// 购买后的三个新增槽位可分别保存和清除颜色，失败请求保留原外观。
func TestAppearanceHTTPExtendedColors(t *testing.T) {
	app, request := shopHTTPRequest(t)
	const path = "/api/v1/appearance"
	command := appearanceHTTPRequest(1, character.DefaultCharacterKey)
	walletVersion := int64(1)
	colors := map[string]string{"upper_color_key": "yellow"}
	for _, item := range []struct {
		slot  string // 穿戴和颜色对应的槽位。
		key   string // 正式素材的稳定身份。
		color string // 要保存的预设色。
	}{
		{"head", "kaykit-adventurers-mage-head", "gray"},
		{"lower", "kaykit-adventurers-mage-lower", "green"},
		{"shoes", "shoes-rogue-v1", "purple"},
	} {
		product := appearanceCatalogQuote(t, app, request, item.key, shop.TypeWearable)
		buy := shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: walletVersion}
		payload, err := json.Marshal(buy)
		if err != nil {
			t.Fatal(err)
		}
		response := request(http.MethodPost, "/api/v1/purchases", string(payload), "extended-colors-buy-"+item.slot)
		var purchase shop.PurchaseResult
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &purchase) != nil {
			t.Fatalf("buy %s: %d %s", item.slot, response.Code, response.Body)
		}
		walletVersion = purchase.Wallet.Version
		command[item.slot+"_wearable_key"] = purchase.Purchase.WearableKey
		colors[item.slot+"_color_key"] = item.color
	}
	for field, key := range colors {
		command[field] = key
	}
	write := func(expected int) {
		t.Helper()
		response := request(http.MethodPut, path, appearanceHTTPBody(t, command), "")
		if response.Code != expected {
			t.Fatalf("write: got %d want %d %s", response.Code, expected, response.Body)
		}
	}
	checkSaved := func(version string) {
		t.Helper()
		response := request(http.MethodGet, path, "", "")
		var state map[string]json.RawMessage
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || string(state["version"]) != version {
			t.Fatalf("read: %d %s", response.Code, response.Body)
		}
		for field, key := range colors {
			expected := "null"
			if key != "" {
				expected = fmt.Sprintf("%q", key)
			}
			if string(state[field]) != expected {
				t.Fatalf("saved %s: got %s want %s", field, state[field], expected)
			}
		}
	}
	write(http.StatusOK)
	checkSaved("2")

	command["expected_version"] = 2
	command["upper_color_key"] = "green"
	command["head_color_key"] = "#ff00ff"
	write(http.StatusBadRequest)
	checkSaved("2")

	command["head_color_key"] = nil
	delete(command, "lower_color_key")
	delete(command, "shoes_color_key")
	write(http.StatusOK)
	colors["upper_color_key"] = "green"
	for _, field := range []string{"head_color_key", "lower_color_key", "shoes_color_key"} {
		colors[field] = ""
	}
	checkSaved("3")
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
	for _, field := range []string{"face_wearable_key", "head_wearable_key", "upper_wearable_key", "lower_wearable_key", "shoes_wearable_key", "back_wearable_key"} {
		if string(fields[field]) != "null" {
			t.Fatalf("default %s must be explicit null: %s", field, initialResponse.Body)
		}
	}
	if string(fields["inventory"]) != "[]" {
		t.Fatalf("empty inventory must be an array: %s", initialResponse.Body)
	}
	for _, field := range []string{"expected_version", "character_key", "face_wearable_key", "head_wearable_key", "upper_wearable_key", "lower_wearable_key", "shoes_wearable_key", "back_wearable_key"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		delete(body, field)
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), field) || !strings.Contains(response.Body.String(), "REQUIRED") {
			t.Fatalf("missing %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, field := range []string{"character_key", "face_wearable_key", "head_wearable_key", "upper_wearable_key", "lower_wearable_key", "shoes_wearable_key", "back_wearable_key"} {
		body := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
		body[field] = ""
		response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("empty %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, invalid := range []string{
		`null`, `[]`, `{"expected_version":null,"character_key":"x","head_wearable_key":null,"upper_wearable_key":null,"lower_wearable_key":null,"shoes_wearable_key":null}`,
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
	app, request := shopHTTPRequest(t)
	initialResponse := request(http.MethodGet, "/api/v1/appearance", "", "")
	var initial appearanceHTTPState
	if initialResponse.Code != http.StatusOK || json.Unmarshal(initialResponse.Body.Bytes(), &initial) != nil || len(initial.Characters) == 0 {
		t.Fatalf("initial: %d %s", initialResponse.Code, initialResponse.Body)
	}
	var wearableKey string
	defaults := map[string]bool{}
	for _, body := range initial.Characters {
		defaults[body.Defaults.Upper] = true
	}
	for _, item := range initial.Wearables {
		if item.Slot == "upper" && !item.Empty && !defaults[item.Key] {
			wearableKey = item.Key
			break
		}
	}
	if wearableKey == "" {
		t.Fatal("fixture has no purchasable upper garment")
	}
	product := appearanceCatalogQuote(t, app, request, wearableKey, shop.TypeWearable)
	unowned := appearanceHTTPRequest(initial.Version, initial.CharacterKey)
	unowned["upper_wearable_key"] = wearableKey
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, unowned), ""); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unowned wearable accepted: %d %s", response.Code, response.Body)
	}
	bought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":%d,"expected_wallet_version":1}`, product.ID, product.Version), "appearance-buy-upper")
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
	body["upper_wearable_key"] = purchase.Purchase.WearableKey
	saved := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
	var state appearanceHTTPState
	if saved.Code != http.StatusOK || json.Unmarshal(saved.Body.Bytes(), &state) != nil || state.UpperWearableKey == nil || *state.UpperWearableKey != purchase.Purchase.WearableKey || len(state.Inventory) != 1 || state.Inventory[0].WearableKey != wearableKey {
		t.Fatalf("owned upper: %d %s", saved.Code, saved.Body)
	}
	invalid := appearanceHTTPRequest(state.Version, initial.CharacterKey)
	invalid["head_wearable_key"] = purchase.Purchase.WearableKey
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong slot accepted: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodPatch, "/api/v1/management/products/"+product.ID, fmt.Sprintf(`{"name":"上衣","coin_price":0,"diamond_price":0,"stock":null,"enabled":false,"expected_version":%d}`, product.Version), ""); response.Code != http.StatusOK {
		t.Fatalf("disable product: %d %s", response.Code, response.Body)
	}
	body["expected_version"] = state.Version
	response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, body), "")
	var afterDisable appearanceHTTPState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &afterDisable) != nil || afterDisable.Version != state.Version+1 || afterDisable.UpperWearableKey == nil || *afterDisable.UpperWearableKey != purchase.Purchase.WearableKey {
		t.Fatalf("disabled product lost owned garment or invalid save changed revision: %d %s", response.Code, response.Body)
	}
	const titleProductID = "historical-wearable-test-title"
	seedHistoricalOfferHTTP(t, app, titleProductID, shop.TypeTitle, "称号", "title-crown-v1")
	titleBought := request(http.MethodPost, "/api/v1/purchases", fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":2}`, titleProductID), "appearance-buy-title")
	var titlePurchase struct {
		Purchase struct {
			ID string `json:"id"` // 称号购买实例。
		} `json:"purchase"` // 称号购买结果。
	}
	if titleBought.Code != http.StatusCreated || json.Unmarshal(titleBought.Body.Bytes(), &titlePurchase) != nil {
		t.Fatalf("buy title: %d %s", titleBought.Code, titleBought.Body)
	}
	invalid = appearanceHTTPRequest(afterDisable.Version, initial.CharacterKey)
	invalid["head_wearable_key"] = titlePurchase.Purchase.ID
	if response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("title purchase accepted by character appearance: %d %s", response.Code, response.Body)
	}
}

// 实际HTTP购买与整套保存分别保留形象、头部和背部，且各字段缺省与错误槽位均被拒绝。
func TestAppearanceHTTPSixSlotOwnedSelections(t *testing.T) {
	app, request := shopHTTPRequest(t)
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
		product := appearanceCatalogQuote(t, app, request, wearable.Key, shop.TypeWearable)
		payload, err := json.Marshal(shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: walletVersion})
		if err != nil {
			t.Fatal(err)
		}
		response := request(http.MethodPost, "/api/v1/purchases", string(payload), "six-slot-buy-"+string(slot))
		var purchase shop.PurchaseResult
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &purchase) != nil {
			t.Fatalf("purchase: %d %s", response.Code, response.Body)
		}
		command[string(slot)+"_wearable_key"] = purchase.Purchase.WearableKey
		walletVersion = purchase.Wallet.Version
	}
	response := request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, command), "")
	var saved shop.AppearanceState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.FaceWearableKey == nil || saved.HeadWearableKey == nil || saved.BackWearableKey == nil || len(saved.Inventory) != 3 {
		t.Fatalf("six slots: %d %s", response.Code, response.Body)
	}
	invalid := appearanceHTTPRequest(saved.Version, saved.CharacterKey)
	invalid["face_wearable_key"] = *saved.BackWearableKey
	response = request(http.MethodPut, "/api/v1/appearance", appearanceHTTPBody(t, invalid), "")
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong slot: %d %s", response.Code, response.Body)
	}
	response = request(http.MethodGet, "/api/v1/appearance", "", "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Version != 2 {
		t.Fatalf("failed save was committed: %d %s", response.Code, response.Body)
	}
}
