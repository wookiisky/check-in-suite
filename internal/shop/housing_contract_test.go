package shop_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestFamilyFurnitureLayout persists a purchased complete household, including two independent chairs.
func TestFamilyFurnitureLayout(t *testing.T) {
	f := newShopFixture(t)
	creditFixture(t, f, 1000, 0)
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	state.Placements[1].X, state.Placements[1].Y = -.75, -.25
	for _, position := range []struct {
		key  string  // Stable catalog identity to purchase.
		x, y float64 // Valid household floor position.
	}{
		{"bed", -3.75, -2.5}, {"cabinet", -3.5, -.5}, {"sofa", -3.5, .75},
		{"coffee-table", -3.5, 2.25}, {"television", -3.5, 3.5}, {"kitchen-counter", -.25, -3.5},
		{"refrigerator", 1.75, -3.5}, {"dining-table", 1, 0}, {"dining-chair", 1, -1.25},
		{"dining-chair", 1, 1.25}, {"toilet", 2.75, -3.25}, {"washbasin", 2.75, -2}, {"shower", 4.25, -3.25},
	} {
		definition, ok := island.Find(position.key)
		if !ok {
			t.Fatalf("missing furniture %s", position.key)
		}
		product := createProduct(t, f, shop.ProductInput{Type: "island", Name: definition.Name, AssetKey: definition.AssetKey, CoinPrice: definition.CoinPrice, Enabled: true})
		purchase := buyProduct(t, f, product).Purchase
		state.Placements = append(state.Placements, island.Placement{ID: purchase.ID, ItemKey: position.key, X: position.x, Y: position.y, Zone: "indoor"})
	}
	saved, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	if err != nil {
		t.Fatalf("complete household rejected: %v", err)
	}
	restored, err := service.Read(context.Background(), f.Principal)
	if err != nil || !reflect.DeepEqual(restored.Placements, saved.Placements) || len(restored.Inventory) != 17 {
		t.Fatalf("restored household: %+v %v", restored, err)
	}
	invalid := append([]island.Placement(nil), saved.Placements...)
	invalid[4].Zone = "outdoor"
	_, err = service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: saved.Version, Placements: invalid})
	requireShopCode(t, err, "INVALID_REQUEST")
	// Replacing a home retains the same interior plan; no purchased furniture needs shrinking.
	cottage := createProduct(t, f, shop.ProductInput{Type: "island", Name: "替换房屋", AssetKey: "island-cottage-v1", Enabled: true})
	purchase := buyProduct(t, f, cottage).Purchase
	state.Placements[0].ID, state.Placements[0].ItemKey = purchase.ID, "cottage"
	if _, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: saved.Version, Placements: state.Placements}); err != nil {
		t.Fatalf("replacement home rejected household: %v", err)
	}
}

// TestHousingAdjustmentAcknowledgement clears the notice only with a successful layout transaction.
func TestHousingAdjustmentAcknowledgement(t *testing.T) {
	f := newShopFixture(t)
	service := island.New(f.DB, f.Accounts.Now)
	state, err := service.Read(context.Background(), f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	state.Placements[0].X = -4
	raw, err := json.Marshal(state.Placements)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec("INSERT INTO island_state(id,version,placements) VALUES(1,7,?)", string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := island.UpgradeHousing(context.Background(), f.DB); err != nil {
		t.Fatal(err)
	}
	state, err = service.Read(context.Background(), f.Principal)
	if err != nil || state.HousingAdjustment == nil || state.HousingAdjustment.Moved < 1 {
		t.Fatalf("missing adjustment notice: %+v %v", state.HousingAdjustment, err)
	}
	if _, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: 7, Placements: state.Placements}); err == nil {
		t.Fatal("stale save accepted")
	}
	failed, err := service.Read(context.Background(), f.Principal)
	if err != nil || failed.HousingAdjustment == nil {
		t.Fatalf("failed save consumed notice: %v", err)
	}
	if _, err := f.DB.Exec("CREATE TRIGGER fail_housing_notice BEFORE UPDATE ON island_housing_upgrade BEGIN SELECT RAISE(ABORT, 'test interruption'); END"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements}); err == nil {
		t.Fatal("expected notice persistence failure")
	}
	interrupted, err := service.Read(context.Background(), f.Principal)
	if err != nil || interrupted.Version != state.Version || interrupted.HousingAdjustment == nil {
		t.Fatalf("interrupted acknowledgement partially committed: %+v %v", interrupted, err)
	}
	if _, err := f.DB.Exec("DROP TRIGGER fail_housing_notice"); err != nil {
		t.Fatal(err)
	}
	saved, err := service.Save(context.Background(), f.Principal, island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	if err != nil || saved.HousingAdjustment != nil {
		t.Fatalf("save notice: %+v %v", saved.HousingAdjustment, err)
	}
	restored, err := service.Read(context.Background(), f.Principal)
	if err != nil || restored.HousingAdjustment != nil {
		t.Fatalf("notice persisted after save: %+v %v", restored.HousingAdjustment, err)
	}
}
