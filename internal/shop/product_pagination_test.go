package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 商品分页绑定筛选条件，来源选项不随当前页截断，删除报价不会打乱后续边界。
func TestProductPaginationFiltersAndStableCursor(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	for _, name := range []string{"alpha title", "beta title", "gamma title"} {
		input := productInput(shop.TypeTitle)
		input.Name = name
		createProduct(t, f, input)
	}
	input := productInput(shop.TypeReward)
	input.Name = "alpha reward"
	createProduct(t, f, input)
	first, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Limit: 1, Group: "appearance"})
	if err != nil || len(first.Items) != 1 || first.NextCursor == nil || first.Facets == nil {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	retireHistoricalProduct(t, f, first.Items[0].ID)
	second, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Limit: 2, Group: "appearance", Cursor: *first.NextCursor})
	if err != nil || len(second.Items) != 2 || second.NextCursor != nil {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	_, err = f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Limit: 1, Type: shop.TypeReward, Cursor: *first.NextCursor})
	requireShopCode(t, err, "INVALID_REQUEST")
	search, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Limit: 1, Type: shop.TypeReward, Search: "ALPHA"})
	if err != nil || len(search.Items) != 1 || search.Items[0].Name != "alpha reward" {
		t.Fatalf("search=%+v err=%v", search, err)
	}
	empty, err := f.Service.ListProductsPage(ctx, f.Principal, false, shop.ProductQuery{Limit: 1, Provider: "missing"})
	if err != nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty=%+v err=%v", empty, err)
	}
}

// 背包搜索在完整订单上分页，不会把未加载的匹配项误报为空。
func TestPurchaseSearchFiltersBeforePagination(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	for _, name := range []string{"first book", "second book", "ÄBC gift"} {
		input := productInput(shop.TypeReward)
		input.Name = name
		buyProduct(t, f, createProduct(t, f, input))
	}
	page, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Limit: 1, Search: "BOOK"})
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil || page.Facets == nil {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	next, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Limit: 1, Search: "book", Cursor: *page.NextCursor})
	if err != nil || len(next.Items) != 1 || next.NextCursor != nil || next.Items[0].ID == page.Items[0].ID {
		t.Fatalf("next=%+v err=%v", next, err)
	}
	_, err = f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Limit: 1, Search: "other", Cursor: *page.NextCursor})
	requireShopCode(t, err, "INVALID_REQUEST")
	unicodePage, unicodeErr := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Limit: 1, Search: "äbc"})
	if unicodeErr != nil || len(unicodePage.Items) != 1 || unicodePage.Items[0].NameSnapshot != "ÄBC gift" {
		t.Fatalf("unicode search=%+v err=%v", unicodePage, unicodeErr)
	}
	missing, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Limit: 1, Provider: "missing"})
	if err != nil || len(missing.Items) != 0 || missing.NextCursor != nil {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}
}
