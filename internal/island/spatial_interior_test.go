package island

import (
	"context"
	"reflect"
	"testing"
)

// TestSpatialInteriorWallsAndEntries 在真实事务中拒绝穿墙和堵门，失败不改布局。
func TestSpatialInteriorWallsAndEntries(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	// 所有权取真实订单快照，不依赖当前商品名称或上架状态。
	if _, err := f.db.Exec(`INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('chair-offer','island','椅子','unused',0,0,0,1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('chair-owned','chair-offer',1,'camp-dining-chair-v1','island','成交名称','','unused',0,0,'owned',1)`); err != nil {
		t.Fatal(err)
	}
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	var baseline SpatialState
	for _, tc := range []struct {
		name  string
		x, z  int
		valid bool
	}{
		{"open floor", -180, -180, true},
		{"outer wall", -280, 0, false},
		{"bathroom partition", 100, -255, false},
		{"main entry", 0, 240, false},
		{"bathroom doorway", 105, -175, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := spatialInput(state)
			input.Placements = append(input.Placements, SpatialPlacement{InstanceID: "chair-owned", ItemKey: "camp-dining-chair-v1", Space: SpatialIndoor, XCM: tc.x, ZCM: tc.z})
			saved, err := f.service.SaveSpatial(ctx, f.principal, input)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
			if tc.valid {
				baseline = saved
				state = saved
				state.Placements = state.Placements[:len(state.Placements)-1]
				return
			}
			read, readErr := f.service.ReadSpatial(ctx, f.principal)
			if readErr != nil || !reflect.DeepEqual(read, baseline) {
				t.Fatalf("rejected save changed state: %+v %v", read, readErr)
			}
		})
	}
}

// TestSpatialBathroomFitsFixtures 真实物件外沿可以同时放入卫生间且保留门廊。
func TestSpatialBathroomFitsFixtures(t *testing.T) {
	configuration := spatialConfigurationData()
	state := SpatialState{Scene: configuration.Scene, Catalog: configuration.Catalog, Placements: configuration.DefaultPlacements}
	for _, placement := range configuration.DefaultPlacements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: placement.InstanceID, ItemKey: placement.ItemKey})
	}
	placements := []SpatialPlacement{
		{InstanceID: "bath-toilet", ItemKey: "camp-toilet-v1", Space: SpatialIndoor, XCM: 155, ZCM: -255, Rotation: 1},
		{InstanceID: "bath-basin", ItemKey: "camp-washbasin-v1", Space: SpatialIndoor, XCM: 255, ZCM: -260},
		{InstanceID: "bath-shower", ItemKey: "camp-shower-v1", Space: SpatialIndoor, XCM: 235, ZCM: -156},
	}
	for _, placement := range placements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: placement.InstanceID, ItemKey: placement.ItemKey})
	}
	input := spatialInput(state)
	input.EnvironmentKey = configuration.DefaultEnvironment
	input.SceneKey = configuration.Scene.Key
	input.Placements = append(input.Placements, placements...)
	if err := validateSpatialPlacements(input, state); err != nil {
		t.Fatal(err)
	}
}

// TestSpatialCatalogDefaultInstances 验证三件免费物件使用明确身份且默认布局可保存。
func TestSpatialCatalogDefaultInstances(t *testing.T) {
	f := newSpatialFixture(t)
	state, err := f.service.ReadSpatial(context.Background(), f.principal)
	if err != nil {
		t.Fatal(err)
	}
	want := []SpatialOwnedItem{{InstanceID: "base:house3d", ItemKey: "camp-house-v1", PlacedSceneKey: "seaside-v1"}, {InstanceID: "base:reading3d", ItemKey: "camp-reading-desk-v1", PlacedSceneKey: "seaside-v1"}, {InstanceID: "base:sport3d", ItemKey: "camp-sports-area-v1", PlacedSceneKey: "seaside-v1"}}
	if !reflect.DeepEqual(state.Inventory, want) {
		t.Fatalf("default inventory=%+v", state.Inventory)
	}
	reading := state.Placements[1]
	if reading.Space != SpatialIndoor || reading.XCM != -150 || reading.ZCM != 0 {
		t.Fatalf("default reading desk is outside the furnished room: %+v", reading)
	}
	if _, err = f.service.SaveSpatial(context.Background(), f.principal, spatialInput(state)); err != nil {
		t.Fatal(err)
	}
}

// TestSpatialInventoryBeyondOrderPage 完整库存不会截断为订单列表的一页。
func TestSpatialInventoryBeyondOrderPage(t *testing.T) {
	f := newSpatialFixture(t)
	if _, err := f.db.Exec(`INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,deleted_at,created_at,updated_at) VALUES('many-chairs','island','已删除入口','unused',0,0,0,1,1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<55)
		INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at)
		SELECT 'owned-chair-'||i,'many-chairs',1,'camp-dining-chair-v1','island','成交名称','','unused',0,0,'owned',i FROM n`); err != nil {
		t.Fatal(err)
	}
	state, err := f.service.ReadSpatial(context.Background(), f.principal)
	if err != nil || len(state.Inventory) != 58 {
		t.Fatalf("complete inventory count=%d err=%v", len(state.Inventory), err)
	}
	input := spatialInput(state)
	input.Placements = append(input.Placements, SpatialPlacement{InstanceID: "owned-chair-55", ItemKey: "camp-dining-chair-v1", Space: SpatialIndoor, XCM: -180, ZCM: -180})
	if _, err = f.service.SaveSpatial(context.Background(), f.principal, input); err != nil {
		t.Fatal(err)
	}
}

// TestSpatialBallPlacement 球能放在运动标线上且不堵路，但不能塞进房屋实体。
func TestSpatialBallPlacement(t *testing.T) {
	configuration := spatialConfigurationData()
	state := SpatialState{Scene: configuration.Scene, Catalog: configuration.Catalog, Placements: configuration.DefaultPlacements}
	for _, placement := range configuration.DefaultPlacements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: placement.InstanceID, ItemKey: placement.ItemKey})
	}
	state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: "owned-ball", ItemKey: "camp-ball-v1"})
	for _, tc := range []struct {
		name  string
		x, z  int
		valid bool
	}{{"sports markings", 650, 0, true}, {"nonblocking entrance ball", 0, 360, true}, {"inside house volume", 0, 0, false}} {
		t.Run(tc.name, func(t *testing.T) {
			input := spatialInput(state)
			input.SceneKey, input.EnvironmentKey = configuration.Scene.Key, configuration.DefaultEnvironment
			input.Placements = append(input.Placements, SpatialPlacement{InstanceID: "owned-ball", ItemKey: "camp-ball-v1", Space: SpatialOutdoor, XCM: tc.x, ZCM: tc.z})
			if err := validateSpatialPlacements(input, state); (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}
