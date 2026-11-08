package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestManagementProductBindingsHTTP verifies dress-up listings are published and only terms can be edited.
func TestManagementProductBindingsHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	body := character.Definitions()[0]
	for _, candidate := range character.Definitions() {
		if candidate.Sellable {
			body = candidate
			break
		}
	}
	if err := shop.SeedCharacterProducts(context.Background(), app.DB, 1); err != nil {
		t.Fatal(err)
	}
	response := request(http.MethodGet, "/api/v1/products?include_inactive=true&type=character", "", "")
	var catalog shop.ProductList
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog.Items) != 1 {
		t.Fatalf("catalog=%d %s", response.Code, response.Body)
	}
	product := catalog.Items[0]
	if product.Type != shop.TypeCharacter || product.CharacterKey != body.Key || product.AssetKey != body.ThumbnailAssetKey || product.Stock != nil {
		t.Fatalf("published product=%+v", product)
	}
	const terms = `"name":"试用报价","coin_price":0,"diamond_price":0,"stock":null,"enabled":true`
	createBody := fmt.Sprintf(`{"asset_key":%q,%s}`, body.ThumbnailAssetKey, terms)
	for _, asset := range []string{body.ThumbnailAssetKey, "title-crown-v1", "reward-gift-v1", "activity-reading-book-v1", "unknown"} {
		response := request(http.MethodPost, "/api/v1/management/products", fmt.Sprintf(`{"asset_key":%q,%s}`, asset, terms), asset)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"asset_key":"INVALID_ASSET"`) {
			t.Fatalf("invalid asset %s: %d %s", asset, response.Code, response.Body)
		}
	}
	path := "/api/v1/management/products/" + product.ID
	patch := `{"name":"更新报价","coin_price":1,"diamond_price":2,"stock":0,"enabled":false,"expected_version":1}`
	for _, field := range []string{`"asset_key":"other"`, `"type":"reward"`, `"description":"other"`} {
		response := request(http.MethodPatch, path, strings.TrimSuffix(patch, "}")+","+field+"}", "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("field %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	response = request(http.MethodPatch, path, patch, "")
	var updated shop.Product
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &updated) != nil || updated.Name != "更新报价" ||
		updated.CoinPrice != 1 || updated.DiamondPrice != 2 || updated.Stock == nil || *updated.Stock != 0 || updated.Enabled ||
		updated.AssetKey != product.AssetKey || updated.Type != product.Type || updated.CharacterKey != product.CharacterKey {
		t.Fatalf("update=%d %s", response.Code, response.Body)
	}
	if stale := request(http.MethodPatch, path, patch, ""); stale.Code != http.StatusConflict {
		t.Fatalf("stale update=%d %s", stale.Code, stale.Body)
	}
	unlimited := strings.ReplaceAll(strings.Replace(patch, `"stock":0`, `"stock":null`, 1), `"expected_version":1`, `"expected_version":2`)
	response = request(http.MethodPatch, path, unlimited, "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &updated) != nil || updated.Stock != nil {
		t.Fatalf("restore unlimited stock=%d %s", response.Code, response.Body)
	}
	if deleted := request(http.MethodDelete, path, `{"expected_version":3}`, ""); deleted.Code != http.StatusNotFound {
		t.Fatalf("delete=%d %s", deleted.Code, deleted.Body)
	}
	const retiredID = "historical-managed-reward"
	seedHistoricalOfferHTTP(t, app, retiredID, shop.TypeReward, "旧文本奖励", "reward-gift-v1")
	if retired := request(http.MethodPatch, "/api/v1/management/products/"+retiredID, patch, ""); retired.Code != http.StatusNotFound {
		t.Fatalf("retired offer still editable: %d %s", retired.Code, retired.Body)
	}
	for _, query := range []string{"", "&limit=48", "&type=reward"} {
		response = request(http.MethodGet, "/api/v1/products?include_inactive=true"+query, "", "")
		var management shop.ProductList
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &management) != nil ||
			slices.ContainsFunc(management.Items, func(item shop.Product) bool { return item.ID == retiredID }) {
			t.Fatalf("retired offer visible in managed list: %d %s", response.Code, response.Body)
		}
	}
	if locked := request(http.MethodPost, "/api/v1/management/lock", "", ""); locked.Code != http.StatusNoContent {
		t.Fatalf("lock=%d %s", locked.Code, locked.Body)
	}
	if response = request(http.MethodPatch, path, strings.Replace(patch, `"expected_version":1`, `"expected_version":3`, 1), ""); response.Code != http.StatusForbidden {
		t.Fatalf("locked update=%d %s", response.Code, response.Body)
	}
	if response = request(http.MethodPost, "/api/v1/management/products", createBody, "managed-offer"); response.Code != http.StatusForbidden {
		t.Fatalf("locked create=%d %s", response.Code, response.Body)
	}
}

// TestManagementCampCategoriesHTTP verifies full categories and filtering before the page boundary.
func TestManagementCampCategoriesHTTP(t *testing.T) {
	_, request := shopHTTPRequest(t)
	assets := map[string][]string{}
	for _, item := range island.SpatialCatalog() {
		if !item.Free {
			assets[item.Category] = append(assets[item.Category], item.ThumbnailAssetKey)
		}
	}
	if len(assets["building"]) == 0 || len(assets["furniture"]) < 2 {
		t.Fatal("fixture requires one building and two furniture materials")
	}
	var purchasedID string
	for index, key := range []string{assets["building"][0], assets["furniture"][0], assets["furniture"][1]} {
		name := fmt.Sprintf("营地物品 %d", index)
		body := fmt.Sprintf(`{"asset_key":%q,"name":%q,"coin_price":0,"diamond_price":0,"stock":null,"enabled":%t}`, key, name, index == 1)
		response := request(http.MethodPost, "/api/v1/management/products", body, fmt.Sprintf("camp-%d", index))
		var created shop.Product
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil {
			t.Fatalf("create=%d %s", response.Code, response.Body)
		}
		if index == 1 {
			purchasedID = created.ID
			buy := fmt.Sprintf(`{"product_id":%q,"expected_product_version":1,"expected_wallet_version":1}`, purchasedID)
			if bought := request(http.MethodPost, "/api/v1/purchases", buy, "managed-camp-purchase"); bought.Code != http.StatusCreated {
				t.Fatalf("buy=%d %s", bought.Code, bought.Body)
			}
			patch := fmt.Sprintf(`{"name":%q,"coin_price":0,"diamond_price":0,"stock":null,"enabled":false,"expected_version":1}`, name)
			if disabled := request(http.MethodPatch, "/api/v1/management/products/"+purchasedID, patch, ""); disabled.Code != http.StatusOK {
				t.Fatalf("disable=%d %s", disabled.Code, disabled.Body)
			}
		}
	}
	path := "/api/v1/products?include_inactive=true&group=camp&category=furniture&limit=1"
	response := request(http.MethodGet, path, "", "")
	var page shop.ProductList
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Items) != 1 ||
		page.Items[0].Enabled || page.NextCursor == nil || !slices.Contains(page.CampCategories, "building") || !slices.Contains(page.CampCategories, "furniture") {
		t.Fatalf("first=%d %s", response.Code, response.Body)
	}
	first := page.Items[0]
	if response := request(http.MethodGet, strings.Replace(path, "category=furniture", "category=building", 1)+"&cursor="+*page.NextCursor, "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("cursor accepted for another category: %d %s", response.Code, response.Body)
	}
	response = request(http.MethodGet, path+"&cursor="+*page.NextCursor, "", "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Items) != 1 ||
		page.Items[0].ID == first.ID || page.NextCursor != nil || !slices.Contains(page.CampCategories, "building") {
		t.Fatalf("second=%d %s", response.Code, response.Body)
	}
	if !slices.ContainsFunc([]shop.Product{first, page.Items[0]}, func(item shop.Product) bool {
		return item.ID == purchasedID && item.Owned && !item.Enabled
	}) {
		t.Fatalf("inactive owned offer absent from both management pages: %+v %+v", first, page.Items[0])
	}
}

// TestManagementMaterialsHTTP reads live catalog relationships without exposing new saleable types.
func TestManagementMaterialsHTTP(t *testing.T) {
	_, request := shopHTTPRequest(t)
	const path = "/api/v1/management/materials"
	response := request(http.MethodGet, path, "", "")
	var materials shop.ManagementMaterials
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &materials) != nil ||
		len(materials.Items) == 0 || len(materials.Activities) == 0 {
		t.Fatalf("materials=%d %s", response.Code, response.Body)
	}
	saleable := map[string]bool{}
	free := map[string]bool{}
	for _, item := range materials.Items {
		if item.Asset.Kind == "model" || item.Asset.Kind == "animation" || item.Asset.Kind == "title" || item.Asset.Kind == "reward" {
			t.Fatalf("unrelated resource exposed as a material: %+v", item)
		}
		if item.Saleable {
			if saleable[item.Asset.Key] || item.Asset.Free {
				t.Fatalf("ambiguous or free saleable material: %+v", item)
			}
			saleable[item.Asset.Key] = true
		} else {
			free[item.Asset.Key] = true
		}
	}
	defaultBody, ok := character.Get(character.DefaultCharacterKey)
	if !ok || !free[defaultBody.ThumbnailAssetKey] || saleable[defaultBody.ThumbnailAssetKey] {
		t.Fatal("default character should be read-only")
	}
	for _, scene := range island.SpatialSceneDefinitions() {
		for _, body := range character.Definitions() {
			presentation, configured := scene.Scene.ActivityPresentations["read"]
			if !configured {
				continue
			}
			animation := body.Animations[presentation.Action]
			if !slices.ContainsFunc(materials.Activities, func(binding shop.ManagementActivityMaterial) bool {
				return binding.SceneKey == scene.Key && binding.CharacterKey == body.Key && binding.Activity == "read" &&
					binding.AssetKey == animation.AssetKey && binding.Clip == animation.Clip && binding.AttachmentAssetKey == "activity-reading-book-v1"
			}) {
				t.Fatalf("missing current reading asset for %s, %s", scene.Key, body.Key)
			}
		}
	}
	if locked := request(http.MethodPost, "/api/v1/management/lock", "", ""); locked.Code != http.StatusNoContent {
		t.Fatalf("lock=%d %s", locked.Code, locked.Body)
	}
	if response := request(http.MethodGet, path, "", ""); response.Code != http.StatusForbidden {
		t.Fatalf("materials available after lock: %d %s", response.Code, response.Body)
	}
}
