package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 真实序列化与路由必须保留角色成交身份，且身体订单不能充当独立穿戴商品。
func TestCharacterPurchaseAndSharedOutfitHTTP(t *testing.T) {
	_, request := shopHTTPRequest(t)
	var body character.Definition
	for _, item := range character.Definitions() {
		if item.Key != character.DefaultCharacterKey {
			body = item
			break
		}
	}
	if body.Key == "" {
		t.Fatal("正式目录缺少可购买的新角色")
	}
	input := shop.ProductCreate{AssetKey: body.ThumbnailAssetKey, ProductTerms: shop.ProductTerms{Name: body.Name, Enabled: true}}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	response := request("POST", "/api/v1/management/products", string(data), "character-product")
	var product shop.Product
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &product) != nil || product.CharacterKey != body.Key {
		t.Fatalf("offer: %d %s", response.Code, response.Body)
	}
	command := appearanceHTTPRequest(1, body.Key)
	response = request("PUT", "/api/v1/appearance", appearanceHTTPBody(t, command), "")
	if response.Code != 422 {
		t.Fatalf("unowned role saved: %d %s", response.Code, response.Body)
	}
	data, err = json.Marshal(shop.BuyInput{ProductID: product.ID, ExpectedProductVersion: product.Version, ExpectedWalletVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	response = request("POST", "/api/v1/purchases", string(data), "character-purchase")
	var result shop.PurchaseResult
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Purchase.CharacterKey != body.Key {
		t.Fatalf("purchase: %d %s", response.Code, response.Body)
	}
	command = appearanceHTTPRequest(1, body.Key)
	response = request("PUT", "/api/v1/appearance", appearanceHTTPBody(t, command), "")
	var saved shop.AppearanceState
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Version != 2 || len(saved.Inventory) != 0 || len(saved.CharacterInventory) != 1 {
		t.Fatalf("body purchase: %d %s", response.Code, response.Body)
	}
	invalid := appearanceHTTPRequest(2, body.Key)
	invalid["head_purchase_id"] = result.Purchase.ID
	response = request("PUT", "/api/v1/appearance", appearanceHTTPBody(t, invalid), "")
	if response.Code != 422 {
		t.Fatalf("body order accepted as garment: %d %s", response.Code, response.Body)
	}

	initial, _ := character.Get(character.DefaultCharacterKey)
	command = appearanceHTTPRequest(2, body.Key)
	command["head_free_wearable_key"] = initial.Defaults.Head
	command["upper_free_wearable_key"] = initial.Defaults.Upper
	command["lower_free_wearable_key"] = initial.Defaults.Lower
	command["shoes_free_wearable_key"] = initial.Defaults.Shoes
	response = request("PUT", "/api/v1/appearance", appearanceHTTPBody(t, command), "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Version != 3 || saved.CharacterKey != body.Key || saved.UpperFreeWearableKey == nil || *saved.UpperFreeWearableKey != initial.Defaults.Upper {
		t.Fatalf("initial free clothes cannot be shared: %d %s", response.Code, response.Body)
	}
	response = request("GET", "/api/v1/appearance", "", "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.HeadFreeWearableKey == nil || *saved.HeadFreeWearableKey != initial.Defaults.Head {
		t.Fatalf("free clothes not retained: %d %s", response.Code, response.Body)
	}

}
