package island

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// grantSpatialScenes 通过真实订单快照授予测试场景，不依赖当前报价状态。
func grantSpatialScenes(t *testing.T, f spatialFixture, keys ...string) {
	t.Helper()
	for _, key := range keys {
		_, err := f.db.Exec(`INSERT INTO products(id,type,name,asset_key,scene_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,'scene','测试场景','unused',?,0,0,0,1,1)`, "offer:"+key, key)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.db.Exec(`INSERT INTO purchases(id,product_id,type_snapshot,scene_key_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES(?,?,'scene',?,'已购场景','','unused',0,0,'owned',1)`, "purchase:"+key, "offer:"+key, key)
		if err != nil {
			t.Fatal(err)
		}
	}
}

// TestSpatialSceneOwnershipAndDefaults 购买增加独立空间，读取不创建状态或赠送物件。
func TestSpatialSceneOwnershipAndDefaults(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	if _, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1"); err == nil {
		t.Fatal("unowned scene readable")
	}
	scenes, err := f.service.ReadSpatialScenes(ctx, f.principal)
	if err != nil || len(scenes) != 3 {
		t.Fatalf("scenes=%+v err=%v", scenes, err)
	}
	grantSpatialScenes(t, f, "forest-courtyard-v1")
	state, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != 1 || len(state.Placements) != 0 || state.Scene.House != nil || len(state.Inventory) != 3 {
		t.Fatalf("new scene=%+v", state)
	}
	for _, item := range state.Inventory {
		if item.PlacedSceneKey != "seaside-v1" {
			t.Fatalf("free item not occupied by seaside: %+v", item)
		}
	}
	var count int
	if err = f.db.QueryRow(`SELECT COUNT(*) FROM island_scene_states`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("read wrote state: %d %v", count, err)
	}
	scenes, err = f.service.ReadSpatialScenes(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	for _, scene := range scenes {
		if scene.Key == "forest-courtyard-v1" && !scene.Owned {
			t.Fatal("purchase missing from list")
		}
	}
}

// TestSpatialScenesIndependentAndMovableInstances 场景版本独立，物件收起后才可搬往另一场景。
func TestSpatialScenesIndependentAndMovableInstances(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	grantSpatialScenes(t, f, "forest-courtyard-v1", "lakeside-garden-v1")
	seaside, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	forest, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil {
		t.Fatal(err)
	}
	input := spatialInput(forest)
	input.Placements = []SpatialPlacement{seaside.Placements[0]}
	if _, err = f.service.SaveSpatial(ctx, f.principal, input); err == nil {
		t.Fatal("copied occupied house")
	}
	original, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil || !reflect.DeepEqual(original, seaside) {
		t.Fatalf("rejection changed seaside %v", err)
	}
	remove := spatialInput(seaside)
	remove.Placements = []SpatialPlacement{}
	removed, err := f.service.SaveSpatial(ctx, f.principal, remove)
	if err != nil {
		t.Fatal(err)
	}
	if removed.Scene.House != nil {
		t.Fatal("removed house still resolved")
	}
	forest, err = f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil {
		t.Fatal(err)
	}
	input = spatialInput(forest)
	input.EnvironmentKey = "dusk"
	input.Placements = []SpatialPlacement{seaside.Placements[0]}
	moved, err := f.service.SaveSpatial(ctx, f.principal, input)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Scene.House == nil || moved.Version != 2 {
		t.Fatalf("moved=%+v", moved)
	}
	reread, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if reread.Version != removed.Version || reread.EnvironmentKey != removed.EnvironmentKey || len(reread.Placements) != 0 {
		t.Fatal("forest save changed seaside")
	}
	for _, item := range reread.Inventory {
		if item.InstanceID == "base:house3d" && item.PlacedSceneKey != "forest-courtyard-v1" {
			t.Fatalf("missing cross-scene inventory location: %+v", item)
		}
	}
	lake, err := f.service.ReadSpatialScene(ctx, f.principal, "lakeside-garden-v1")
	if err != nil || lake.Version != 1 || len(lake.Placements) != 0 {
		t.Fatalf("lake changed: %+v %v", lake, err)
	}
}

// TestSpatialConcurrentCrossSceneOccupancy 在真实SQLite独立连接中，同一实例只能进入一个场景。
func TestSpatialConcurrentCrossSceneOccupancy(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	grantSpatialScenes(t, f, "forest-courtyard-v1", "lakeside-garden-v1")
	seaside, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	remove := spatialInput(seaside)
	remove.Placements = []SpatialPlacement{}
	if _, err = f.service.SaveSpatial(ctx, f.principal, remove); err != nil {
		t.Fatal(err)
	}
	forest, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil {
		t.Fatal(err)
	}
	lake, err := f.service.ReadSpatialScene(ctx, f.principal, "lakeside-garden-v1")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, state := range []SpatialState{forest, lake} {
		go func(i int, state SpatialState) {
			input := spatialInput(state)
			input.Placements = []SpatialPlacement{seaside.Placements[0]}
			<-start
			svc := f.service
			if i == 1 {
				svc = f.contender
			}
			_, err := svc.SaveSpatial(ctx, f.principal, input)
			results <- err
		}(i, state)
	}
	close(start)
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		var failure *core.Error
		if err == nil {
			success++
		} else if errors.As(err, &failure) && failure.FieldErrors["placements"] == "PLACED_IN_OTHER_SCENE" {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	var rows int
	if err = f.db.QueryRow(`SELECT COUNT(*) FROM island_scene_placements WHERE instance_id='base:house3d'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("placement rows=%d err=%v", rows, err)
	}
	for _, key := range []string{"forest-courtyard-v1", "lakeside-garden-v1"} {
		state, err := f.service.ReadSpatialScene(ctx, f.principal, key)
		if err != nil {
			t.Fatal(err)
		}
		if len(state.Placements) == 0 && state.Version != 1 {
			t.Fatal("failed contender changed scene version")
		}
	}
}

// TestSpatialNoHouseRejectsIndoorAndMultipleHouses 无房允许室外布置，但不能保留室内物件。
func TestSpatialNoHouseRejectsIndoorAndMultipleHouses(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	input := spatialInput(state)
	input.Placements = input.Placements[1:]
	if _, err = f.service.SaveSpatial(ctx, f.principal, input); err == nil {
		t.Fatal("indoor item accepted without house")
	}
	input.Placements = []SpatialPlacement{}
	saved, err := f.service.SaveSpatial(ctx, f.principal, input)
	if err != nil || saved.Scene.House != nil {
		t.Fatalf("empty layout failed: %v", err)
	}
}

// TestSpatialFixedSceneryBlocksPlacementAndEntry 固定景物的声明占地与门外通路参与服务端验证。
func TestSpatialFixedSceneryBlocksPlacementAndEntry(t *testing.T) {
	configuration := spatialConfigurationData()
	state := SpatialState{Scene: configuration.Scene, Catalog: configuration.Catalog, Placements: configuration.DefaultPlacements}
	for _, placement := range configuration.DefaultPlacements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: placement.InstanceID, ItemKey: placement.ItemKey})
	}
	input := spatialInput(state)
	input.SceneKey = configuration.Scene.Key
	input.EnvironmentKey = configuration.DefaultEnvironment
	obstacle := SpatialFootprint{WidthCM: 100, DepthCM: 100}
	state.Scene.FixedObjects = []SpatialFixedObject{{Key: "fixed-tree", XCM: 0, ZCM: 0, Footprint: obstacle, WalkObstacle: &obstacle, BlocksPlacement: true}}
	if err := validateSpatialPlacements(input, state); err == nil {
		t.Fatal("fixed scenery overlap accepted")
	}
	state.Scene.FixedObjects[0].XCM = 0
	state.Scene.FixedObjects[0].ZCM = 360
	if err := validateSpatialPlacements(input, state); err == nil {
		t.Fatal("fixed scenery blocked doorway")
	}
	state.Scene.FixedObjects[0].XCM = -1000
	state.Scene.FixedObjects[0].ZCM = -1000
	if err := validateSpatialPlacements(input, state); err != nil {
		t.Fatalf("unrelated fixed scenery blocked save: %v", err)
	}
}

// TestSpatialSceneConfigurationSnapshots 配置查询返回独立切片和房型，防止草稿污染正式定义。
func TestSpatialSceneConfigurationSnapshots(t *testing.T) {
	scenes := SpatialSceneDefinitions()
	scenes[1].Scene.Regions[0].Polygon[0].XCM = 999999
	fresh, found := SpatialSceneFind(scenes[1].Key)
	if !found || fresh.Scene.Regions[0].Polygon[0].XCM == 999999 {
		t.Fatal("scene configuration shared mutable geometry")
	}
	houses := SpatialHouseDefinitions()
	house := houses["seaside-house-v1"]
	house.Walls[0].MinXCM = 999999
	if fresh := SpatialHouseDefinitions()["seaside-house-v1"]; fresh.Walls[0].MinXCM == 999999 {
		t.Fatal("house configuration shared mutable geometry")
	}
}

// TestSpatialSceneWriteFailureRollsBackVirtualSeaside 目标场景写入失败时，首次物化的海边也不能留下部分状态。
func TestSpatialSceneWriteFailureRollsBackVirtualSeaside(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	grantSpatialScenes(t, f, "forest-courtyard-v1")
	forest, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(`CREATE TRIGGER scene_write_failure BEFORE INSERT ON island_scene_states WHEN NEW.scene_key='forest-courtyard-v1' BEGIN SELECT RAISE(ABORT,'test write failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.SaveSpatial(ctx, f.principal, spatialInput(forest)); err == nil {
		t.Fatal("injected write succeeded")
	}
	for _, table := range []string{"island_scene_states", "island_scene_placements"} {
		var count int
		if err = f.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial %s count=%d err=%v", table, count, err)
		}
	}
	after, err := f.service.ReadSpatialScene(ctx, f.principal, "forest-courtyard-v1")
	if err != nil || !reflect.DeepEqual(after, forest) {
		t.Fatalf("failed write changed target scene: %v", err)
	}
}

// TestSpatialPlacementOrderSurvivesStorage 保存后保持提交顺序，恢复核对不误判排列变化。
func TestSpatialPlacementOrderSurvivesStorage(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	input := spatialInput(state)
	input.Placements[0], input.Placements[2] = input.Placements[2], input.Placements[0]
	saved, err := f.service.SaveSpatial(ctx, f.principal, input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved.Placements, input.Placements) {
		t.Fatal("storage reordered submitted placements")
	}
}

// TestSpatialOnlyOneOwnedHouseAllowed 两个不同拥有实例也不能在同一场景放两栋主屋。
func TestSpatialOnlyOneOwnedHouseAllowed(t *testing.T) {
	configuration := spatialConfigurationData()
	state := SpatialState{Scene: configuration.Scene, Catalog: configuration.Catalog, Placements: configuration.DefaultPlacements, Inventory: []SpatialOwnedItem{{InstanceID: "one-house", ItemKey: "camp-house-v1"}, {InstanceID: "another-house", ItemKey: "camp-house-v1"}}}
	input := SpatialSaveInput{SceneKey: configuration.Scene.Key, EnvironmentKey: configuration.DefaultEnvironment, Placements: []SpatialPlacement{{InstanceID: "one-house", ItemKey: "camp-house-v1", Space: SpatialOutdoor, XCM: -600}, {InstanceID: "another-house", ItemKey: "camp-house-v1", Space: SpatialOutdoor, XCM: 600}}}
	if err := validateSpatialPlacements(input, state); err == nil {
		t.Fatal("two owned houses accepted")
	}
}
