package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 购买同一稳定物件后，所有报价在按页码切片前都从商店排除。
func TestShopBrowseFiltersOwnershipBeforePagination(t *testing.T) {
	app, request := shopHTTPRequest(t)
	furniture := make([]island.SpatialDefinition, 0, 4)
	for _, item := range island.SpatialCatalog() {
		if item.Category == "furniture" && item.Repeatable {
			furniture = append(furniture, item)
			if len(furniture) == 4 {
				break
			}
		}
	}
	if len(furniture) != 4 {
		t.Fatal("fixture needs four repeatable furniture items")
	}

	create := func(name, asset string) shop.Product {
		t.Helper()
		body, err := json.Marshal(shop.ProductCreate{AssetKey: asset, ProductTerms: shop.ProductTerms{Name: name, Enabled: true}})
		if err != nil {
			t.Fatal(err)
		}
		response := request("POST", "/api/v1/management/products", string(body), name)
		var product shop.Product
		if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &product) != nil {
			t.Fatalf("create response=%d %s", response.Code, response.Body)
		}
		return product
	}
	offers := []shop.Product{}
	var alias shop.Product
	for index, item := range furniture {
		offers = append(offers, create(item.Key, item.ThumbnailAssetKey))
		if index == 0 {
			alias = create("same-item-other-offer", item.ThumbnailAssetKey)
		}
	}
	seedHistoricalOfferHTTP(t, app, "old-title", shop.TypeTitle, "old-title", "title-crown-v1")
	seedHistoricalOfferHTTP(t, app, "old-reward", shop.TypeReward, "old-reward", "reward-gift-v1")

	read := func(query string) shop.ShopPage {
		t.Helper()
		response := request("GET", "/api/v1/shop/products?"+query, "", "")
		var page shop.ShopPage
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil {
			t.Fatalf("browse response=%d %s", response.Code, response.Body)
		}
		return page
	}
	first := read("group=camp&category=furniture&page=1&limit=2")
	if first.Page != 1 || first.Total != 5 || len(first.Items) != 2 {
		t.Fatalf("first=%+v", first)
	}
	buy, err := json.Marshal(shop.BuyInput{ProductID: offers[0].ID, ExpectedProductVersion: offers[0].Version, ExpectedWalletVersion: first.Wallet.Version})
	if err != nil {
		t.Fatal(err)
	}
	if response := request("POST", "/api/v1/purchases", string(buy), "shop-browse-purchase"); response.Code != 201 {
		t.Fatalf("purchase response=%d %s", response.Code, response.Body)
	}
	first = read("group=camp&category=furniture&page=1&limit=2")
	last := read("group=camp&category=furniture&page=999&limit=2")
	if first.Total != 3 || len(first.Items) != 2 || last.Total != 3 || last.Page != 2 || len(last.Items) != 1 {
		t.Fatalf("filtered first=%+v last=%+v", first, last)
	}
	for _, item := range append(first.Items, last.Items...) {
		if item.IslandItemKey == furniture[0].Key {
			t.Fatalf("owned stable item in browse results: %+v", item)
		}
	}
	duplicate, err := json.Marshal(map[string]any{
		"product_id": alias.ID, "expected_product_version": alias.Version,
		"expected_wallet_version": first.Wallet.Version, "require_unowned": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response := request("POST", "/api/v1/purchases", string(duplicate), "shop-browse-duplicate"); response.Code != 409 || !strings.Contains(response.Body.String(), "ALREADY_OWNED") {
		t.Fatalf("duplicate response=%d %s", response.Code, response.Body)
	}
	if response := request("GET", "/api/v1/shop/products?group=camp&page=0", "", ""); response.Code != 400 {
		t.Fatalf("zero page response=%d %s", response.Code, response.Body)
	}
	if wardrobe := read("group=appearance&page=1"); wardrobe.Total != 0 {
		t.Fatalf("legacy offers in wardrobe: %+v", wardrobe)
	}
}
