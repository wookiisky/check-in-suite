package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 管理员上架后，每款新素材都能购买、进入库存并保存到真实数据库。
func TestSupplementalArtworkPurchaseAndPlacement(t *testing.T) {
	for _, key := range []string{"flowers", "mushrooms", "rocks", "fence", "bench", "lantern", "tent", "fountain", "swing", "windmill"} {
		t.Run(key, func(t *testing.T) {
			f := newShopFixture(t)
			product := createProduct(t, f, shop.ProductInput{Type: "island", Name: "测试摆件", AssetKey: "island-" + key + "-v1", Enabled: true})
			purchase := buyProduct(t, f, product).Purchase
			service := island.New(f.DB, f.Accounts.Now)
			state, err := service.Read(context.Background(), f.Principal)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, item := range state.Inventory {
				found = found || item.ID == purchase.ID && item.ItemKey == key
			}
			if !found {
				t.Fatalf("purchased %s missing from island inventory", key)
			}
			placement := island.Placement{ID: purchase.ID, ItemKey: key, X: 5, Y: 5, Zone: "outdoor"}
			state.Placements = append(state.Placements, placement)
			saved, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
			if err != nil || saved.Version != state.Version+1 {
				t.Fatalf("save artwork: %+v, %v", saved, err)
			}
			restored, err := service.Read(context.Background(), f.Principal)
			if err != nil || restored.Placements[len(restored.Placements)-1] != placement {
				t.Fatalf("restore artwork: %+v, %v", restored, err)
			}
		})
	}
}
