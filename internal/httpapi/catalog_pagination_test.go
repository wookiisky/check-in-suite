package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 商品浏览的真实HTTP参数控制分页，空页也保留结束标记和完整来源选项。
func TestCatalogProductPaginationHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	seedHistoricalOfferHTTP(t, app, "first", shop.TypeTitle, "first title", "title-crown-v1")
	seedHistoricalOfferHTTP(t, app, "second", shop.TypeTitle, "second title", "title-crown-v1")
	response := request("GET", "/api/v1/products?limit=1&group=appearance", "", "")
	var first shop.ProductList
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &first) != nil || len(first.Items) != 1 || first.NextCursor == nil || first.Facets == nil {
		t.Fatalf("first: %d %s", response.Code, response.Body)
	}
	response = request("GET", "/api/v1/products?limit=1&group=appearance&cursor="+*first.NextCursor, "", "")
	var next shop.ProductList
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &next) != nil || len(next.Items) != 1 || next.NextCursor != nil {
		t.Fatalf("next: %d %s", response.Code, response.Body)
	}
	for _, query := range []string{"limit=0", "limit=101", "limit=1&type=invalid", "limit=1&slot=invalid", "limit=1&cursor=invalid"} {
		response = request("GET", "/api/v1/products?"+query, "", "")
		if response.Code != 400 {
			t.Fatalf("accepted %s: %d %s", query, response.Code, response.Body)
		}
	}
}

// 提供筛选而省略页大小时仍须执行筛选，旧的纯列表请求继续返回全部配置。
func TestCatalogProductFiltersWithoutExplicitLimitHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	seedHistoricalOfferHTTP(t, app, "filtered-title", shop.TypeTitle, "title alpha", "title-crown-v1")
	seedHistoricalOfferHTTP(t, app, "filtered-reward", shop.TypeReward, "reward alpha", "reward-gift-v1")
	for _, query := range []string{"type=reward", "search=reward", "group=appearance"} {
		response := request("GET", "/api/v1/products?"+query, "", "")
		var page shop.ProductList
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.Facets == nil {
			t.Fatalf("filter %s: %d %s", query, response.Code, response.Body)
		}
	}
	response := request("GET", "/api/v1/products?provider=missing", "", "")
	var empty shop.ProductList
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &empty) != nil || len(empty.Items) != 0 {
		t.Fatalf("provider ignored: %d %s", response.Code, response.Body)
	}
	for _, query := range []string{"type=invalid", "cursor=invalid", "slot=invalid"} {
		response = request("GET", "/api/v1/products?"+query, "", "")
		if response.Code != 400 {
			t.Fatalf("invalid filter accepted %s: %d %s", query, response.Code, response.Body)
		}
	}
	response = request("GET", "/api/v1/products", "", "")
	var legacy shop.ProductList
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &legacy) != nil || len(legacy.Items) != 2 {
		t.Fatalf("legacy list changed: %d %s", response.Code, response.Body)
	}
}
