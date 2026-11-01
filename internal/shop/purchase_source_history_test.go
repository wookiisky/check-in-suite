package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 真实旧订单在素材退役和报价刷新后，仍可按稳定物品来源筛选且不改成交快照。
func TestHistoricalPurchaseSourceSurvivesArtworkRetirement(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	const historicalArtwork = "kaykit-furniture-bits-cactus-medium-a-fe0b9b-8c461dde-thumb"
	if _, found := assets.Get(historicalArtwork); found {
		t.Fatal("fixture must represent a retired artwork version")
	}
	definition, found := island.SpatialForThumbnail(historicalArtwork)
	if !found || definition.Provider == "" || definition.PackKey == "" {
		t.Fatal("fixture lost its stable item source")
	}
	id := core.ID()
	if _, err := f.DB.Exec(`INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,'island',?,?,0,0,1,1,1)`, id, definition.Name, historicalArtwork); err != nil {
		t.Fatal(err)
	}
	bought := buyProduct(t, f, shop.Product{ID: id, Version: 1}).Purchase
	if err := shop.SeedSpatialProducts(ctx, f.DB, f.Now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	page, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Provider: definition.Provider, PackKey: definition.PackKey, Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != bought.ID {
		t.Fatalf("historical owned source disappeared: page=%+v err=%v", page, err)
	}
	item := page.Items[0]
	if item.Provider != definition.Provider || item.PackKey != definition.PackKey || item.PackName != definition.PackName {
		t.Fatalf("historical source mismatch: %+v", item)
	}
	if item.AssetKeySnapshot != historicalArtwork || item.NameSnapshot != bought.NameSnapshot || item.DescriptionSnapshot != bought.DescriptionSnapshot || item.CoinPrice != bought.CoinPrice || item.DiamondPrice != bought.DiamondPrice || item.CreatedAt != bought.CreatedAt {
		t.Fatalf("historical transaction snapshot changed: bought=%+v read=%+v", bought, item)
	}
	if len(page.Facets.Providers) != 1 || page.Facets.Providers[0] != definition.Provider || len(page.Facets.Packs) != 1 || page.Facets.Packs[0].Key != definition.PackKey || page.Facets.Packs[0].Provider != definition.Provider || page.Facets.Packs[0].Name != definition.PackName {
		t.Fatalf("historical source omitted from facets: %+v", page.Facets)
	}
}

// 当前受控素材的来源保持原样，普通商品没有物品身份时不会被补成营地物件来源。
func TestPurchaseSourcePreservesCurrentArtworkAndOrdinaryOffers(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	var current island.SpatialDefinition
	for _, definition := range island.SpatialCatalog() {
		if !definition.Free && definition.Provider != "" && definition.PackKey != "" {
			current = definition
			break
		}
	}
	artwork, found := assets.Get(current.ThumbnailAssetKey)
	if !found || artwork.Provider == "" || artwork.PackKey == "" {
		t.Fatal("missing current source fixture")
	}
	spatial := createProduct(t, f, shop.ProductInput{Type: shop.TypeIsland, Name: current.Name, AssetKey: current.ThumbnailAssetKey, Enabled: true})
	owned := buyProduct(t, f, spatial).Purchase
	ordinary := buyProduct(t, f, createProduct(t, f, productInput(shop.TypeTitle))).Purchase
	page, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	for _, item := range page.Items {
		switch item.ID {
		case owned.ID:
			if item.Provider != artwork.Provider || item.PackKey != artwork.PackKey || item.PackName != artwork.PackName {
				t.Fatalf("current artwork source overwritten: %+v", item)
			}
		case ordinary.ID:
			if item.ItemKeySnapshot != "" || item.IslandItemKey != "" || item.Provider != "" || item.PackKey != "" || item.PackName != "" {
				t.Fatalf("ordinary offer inferred an island source: %+v", item)
			}
		default:
			t.Fatalf("unexpected order: %+v", item)
		}
	}
	filtered, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Provider: artwork.Provider, PackKey: artwork.PackKey})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != owned.ID {
		t.Fatalf("source filter included ordinary offer: %+v err=%v", filtered, err)
	}
}
