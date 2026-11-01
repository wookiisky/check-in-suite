package island

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// TestSpatialDefaultAndSave 保证读默认值不写库，新旧布局相互独立。
func TestSpatialDefaultAndSave(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != 1 || state.SceneKey != state.Scene.Key || len(state.Placements) != 1 || len(state.Inventory) != 1 {
		t.Fatalf("unexpected default: %+v", state)
	}
	var count int
	if err = f.db.QueryRow("SELECT COUNT(*) FROM island_spatial_state").Scan(&count); err != nil || count != 0 {
		t.Fatalf("read wrote state count=%d err=%v", count, err)
	}
	if _, err = f.db.Exec("INSERT INTO island_state(id,version,placements) VALUES(1,99,'[]')"); err != nil {
		t.Fatal(err)
	}
	input := spatialInput(state)
	input.Placements[0].XCM = 25
	input.EnvironmentKey = "dusk"
	saved, err := f.service.SaveSpatial(ctx, f.principal, input)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 2 || saved.Placements[0].XCM != 25 || saved.EnvironmentKey != "dusk" {
		t.Fatalf("bad save %+v", saved)
	}
	read, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil || !reflect.DeepEqual(saved, read) {
		t.Fatalf("saved snapshot mismatch err=%v", err)
	}
	if err = f.db.QueryRow("SELECT version FROM island_state WHERE id=1").Scan(&count); err != nil || count != 99 {
		t.Fatalf("old layout changed count=%d err=%v", count, err)
	}
}

// TestSpatialInvalidIsAtomic 拒绝错误身份、越界、非法环境与门外封堵，失败不写部分状态。
func TestSpatialInvalidIsAtomic(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*SpatialSaveInput)
	}{
		{"wrong scene", func(i *SpatialSaveInput) { i.SceneKey = "unknown" }},
		{"wrong environment", func(i *SpatialSaveInput) { i.EnvironmentKey = "unknown" }},
		{"null placements", func(i *SpatialSaveInput) { i.Placements = nil }},
		{"missing house", func(i *SpatialSaveInput) { i.Placements = []SpatialPlacement{} }},
		{"duplicate instance", func(i *SpatialSaveInput) { i.Placements = append(i.Placements, i.Placements[0]) }},
		{"unowned instance", func(i *SpatialSaveInput) { i.Placements[0].InstanceID = "foreign" }},
		{"wrong item", func(i *SpatialSaveInput) { i.Placements[0].ItemKey = "other" }},
		{"wrong space", func(i *SpatialSaveInput) { i.Placements[0].Space = SpatialIndoor }},
		{"unsupported house rotation", func(i *SpatialSaveInput) { i.Placements[0].Rotation = 1 }},
		{"cross water", func(i *SpatialSaveInput) { i.Placements[0].ZCM = 900 }},
		{"door approach crosses water", func(i *SpatialSaveInput) { i.Placements[0].ZCM = 650 }},
		{"unsafe coordinate", func(i *SpatialSaveInput) { i.Placements[0].XCM = int(core.MaxInteger + 1) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := spatialInput(state)
			tc.change(&input)
			if _, err := f.service.SaveSpatial(ctx, f.principal, input); err == nil {
				t.Fatal("invalid save succeeded")
			}
			after, err := f.service.ReadSpatial(ctx, f.principal)
			if err != nil || !reflect.DeepEqual(after, state) {
				t.Fatalf("failed save changed state err=%v", err)
			}
		})
	}
}

// TestSpatialConcurrentSave 同一个真实数据库的两个写连接只接受一个预期版本。
func TestSpatialConcurrentSave(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for index, service := range []*Service{f.service, f.contender} {
		go func(index int, service *Service) {
			input := spatialInput(state)
			input.Placements[0].XCM = (index + 1) * 25
			<-start
			_, err := service.SaveSpatial(ctx, f.principal, input)
			results <- err
		}(index, service)
	}
	close(start)
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		var failure *core.Error
		if err == nil {
			success++
		} else if errors.As(err, &failure) && failure.Code == "VERSION_CONFLICT" {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success %d conflict %d", success, conflict)
	}
	var version int64
	var raw string
	if err = f.db.QueryRow("SELECT version,placements FROM island_spatial_state WHERE id=1").Scan(&version, &raw); err != nil {
		t.Fatal(err)
	}
	var placements []SpatialPlacement
	if err = json.Unmarshal([]byte(raw), &placements); err != nil || version != 2 || len(placements) != 1 {
		t.Fatalf("bad persisted result version=%d err=%v", version, err)
	}
}

// TestSpatialRevokedSession 保存前在事务内复核会话，不接受已经退出的权限。
func TestSpatialRevokedSession(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.accounts.Logout(ctx, f.principal); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.SaveSpatial(ctx, f.principal, spatialInput(state))
	var failure *core.Error
	if !errors.As(err, &failure) || failure.Status != 401 {
		t.Fatalf("got %v", err)
	}
}

// TestSpatialInventoryReadsOwnedSnapshots 不受商品删除、当前名称或订单分页影响。
func TestSpatialInventoryReadsOwnedSnapshots(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	if _, err := f.db.Exec(`INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,deleted_at,created_at,updated_at) VALUES('spatial-offer','island','已删除商品','island-tree-v1',0,0,0,1,1,1)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ id, item string }{{"owned-one", "camp-house-v1"}, {"owned-two", "camp-house-v1"}, {"legacy-2d", "house"}} {
		if _, err := f.db.Exec(`INSERT INTO purchases(id,product_id,repeatable,item_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES(?,'spatial-offer',1,?,'island','成交名称','','island-tree-v1',0,0,'owned',1)`, row.id, row.item); err != nil {
			t.Fatal(err)
		}
	}
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Inventory) != 3 {
		t.Fatalf("expected base and two owned snapshots: %+v", state.Inventory)
	}
	for _, item := range state.Inventory {
		if item.InstanceID == "legacy-2d" {
			t.Fatal("old 2D ownership was silently converted")
		}
	}
	// 同一个已购实例只能放一次；可以用已购主屋替换免费主屋。
	input := spatialInput(state)
	input.Placements[0].InstanceID = "owned-two"
	if _, err = f.service.SaveSpatial(ctx, f.principal, input); err != nil {
		t.Fatal(err)
	}
}

// TestSpatialVersionOverflow 版本递增越过公共整数域时整体失败。
func TestSpatialVersionOverflow(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	state, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(state.Placements)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec(`INSERT INTO island_spatial_state(id,version,scene_key,environment_key,placements) VALUES(1,?,?,?,?)`, core.MaxInteger, state.SceneKey, state.EnvironmentKey, string(raw)); err != nil {
		t.Fatal(err)
	}
	input := spatialInput(state)
	input.ExpectedVersion = core.MaxInteger
	_, err = f.service.SaveSpatial(ctx, f.principal, input)
	var failure *core.Error
	if !errors.As(err, &failure) || failure.Code != "INTEGER_OVERFLOW" {
		t.Fatalf("got %v", err)
	}
	var version int64
	if err = f.db.QueryRow(`SELECT version FROM island_spatial_state WHERE id=1`).Scan(&version); err != nil || version != core.MaxInteger {
		t.Fatalf("partial version update: %d err=%v", version, err)
	}
}

// TestSpatialPlacementBoundaries 将可覆盖物、占地互斥和行走通路分开检查。
func TestSpatialPlacementBoundaries(t *testing.T) {
	configuration := spatialConfigurationData()
	shape := SpatialFootprint{WidthCM: 100, DepthCM: 50}
	solid := SpatialDefinition{Key: "test-solid", Footprint: shape, WalkObstacle: &shape, BlocksPlacement: true, Movable: true, Spaces: []SpatialSpace{SpatialOutdoor, SpatialIndoor}, Rotations: []int{0, 1, 2, 3}, AllowedTerrain: []string{"grass", "sand"}}
	rug := solid
	rug.Key = "test-rug"
	rug.BlocksPlacement = false
	rug.WalkObstacle = nil
	for _, tc := range []struct {
		name          string
		first, second SpatialPlacement
		valid         bool
	}{
		{"touching solid edges", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 600}, SpatialPlacement{InstanceID: "two", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 700}, true},
		{"one centimetre solid overlap", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 600}, SpatialPlacement{InstanceID: "two", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 699}, false},
		{"rug may overlap solid", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 600}, SpatialPlacement{InstanceID: "two", ItemKey: "test-rug", Space: SpatialOutdoor, XCM: 600}, true},
		{"separate coordinate spaces", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 600}, SpatialPlacement{InstanceID: "two", ItemKey: "test-solid", Space: SpatialIndoor}, true},
		{"indoor edge touches", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialIndoor, XCM: 250}, SpatialPlacement{InstanceID: "two", ItemKey: "test-rug", Space: SpatialOutdoor, XCM: 600}, true},
		{"indoor complete footprint overflow", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialIndoor, XCM: 251}, SpatialPlacement{InstanceID: "two", ItemKey: "test-rug", Space: SpatialOutdoor, XCM: 600}, false},
		{"solid blocks doorway approach", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, ZCM: 360}, SpatialPlacement{InstanceID: "two", ItemKey: "test-rug", Space: SpatialOutdoor, XCM: 600}, false},
		{"walkable rug can cover approach", SpatialPlacement{InstanceID: "one", ItemKey: "test-rug", Space: SpatialOutdoor, ZCM: 360}, SpatialPlacement{InstanceID: "two", ItemKey: "test-solid", Space: SpatialOutdoor, XCM: 600}, true},
		{"door approach edge touches", SpatialPlacement{InstanceID: "one", ItemKey: "test-solid", Space: SpatialOutdoor, ZCM: 445}, SpatialPlacement{InstanceID: "two", ItemKey: "test-rug", Space: SpatialOutdoor, XCM: 600}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := SpatialState{Scene: configuration.Scene, Catalog: append(SpatialCatalog(), solid, rug), Placements: configuration.DefaultPlacements, Inventory: []SpatialOwnedItem{{"base:house3d", "camp-house-v1"}, {"one", tc.first.ItemKey}, {"two", tc.second.ItemKey}}}
			input := SpatialSaveInput{SceneKey: configuration.Scene.Key, EnvironmentKey: configuration.DefaultEnvironment, Placements: append(append([]SpatialPlacement{}, configuration.DefaultPlacements...), tc.first, tc.second)}
			if err := validateSpatialPlacements(input, state); (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}
