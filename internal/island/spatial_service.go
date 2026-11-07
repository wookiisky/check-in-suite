package island

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// readSpatialState 保留初始海边读取入口，供既有调用继续使用。
func readSpatialState(ctx context.Context, tx *sql.Tx, accountID int64) (SpatialState, error) {
	return readSpatialSceneState(ctx, tx, accountID, spatialIndex.configuration.Scene.Key)
}

// readSpatialSceneState 在同一快照读取目标布局、全量库存及跨场景占用。
func readSpatialSceneState(ctx context.Context, tx *sql.Tx, accountID int64, key string) (SpatialState, error) {
	definition, found := SpatialSceneFind(key)
	if !found {
		return SpatialState{}, core.Invalid("scene_key", "INVALID_VALUE")
	}
	owned, err := spatialSceneOwned(ctx, tx, accountID, definition)
	if err != nil {
		return SpatialState{}, err
	}
	if !owned {
		return SpatialState{}, core.Invalid("scene_key", "NOT_OWNED")
	}
	configuration := spatialConfigurationData()
	state := SpatialState{Version: 1, SceneKey: key, EnvironmentKey: definition.DefaultEnvironment, Placements: []SpatialPlacement{}, Inventory: []SpatialOwnedItem{}, Catalog: configuration.Catalog, Scene: definition.Scene, Houses: SpatialHouseDefinitions()}
	if key == configuration.Scene.Key {
		state.Placements = configuration.DefaultPlacements
	}
	err = tx.QueryRowContext(ctx, `SELECT version,environment_key FROM island_scene_states WHERE account_id=? AND scene_key=?`, accountID, key).Scan(&state.Version, &state.EnvironmentKey)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return state, err
	}
	if err == nil {
		state.Placements, err = readSpatialPlacements(ctx, tx, accountID, key)
		if err != nil {
			return state, err
		}
	} else if key == configuration.Scene.Key {
		if err = readLegacySpatialState(ctx, tx, accountID, &state); err != nil {
			return state, err
		}
	}
	state.Scene, err = resolveSpatialHouse(state.Scene, state.Placements, state.Catalog)
	if err != nil {
		return state, err
	}
	locations, err := spatialLocations(ctx, tx, accountID, configuration)
	if err != nil {
		return state, err
	}
	for _, placement := range configuration.DefaultPlacements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{InstanceID: placement.InstanceID, ItemKey: placement.ItemKey, PlacedSceneKey: locations[placement.InstanceID]})
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,item_key_snapshot FROM purchases WHERE account_id=? AND status='owned' ORDER BY created_at,id`, accountID)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var item SpatialOwnedItem
		if err = rows.Scan(&item.InstanceID, &item.ItemKey); err != nil {
			return state, err
		}
		if _, found := spatialFindDefinition(state.Catalog, item.ItemKey); found {
			item.PlacedSceneKey = locations[item.InstanceID]
			state.Inventory = append(state.Inventory, item)
		}
	}
	return state, rows.Err()
}

// readLegacySpatialState 兼容迁移后尚由旧初始化入口写入的海边布局。
func readLegacySpatialState(ctx context.Context, tx *sql.Tx, accountID int64, state *SpatialState) error {
	var raw string
	err := tx.QueryRowContext(ctx, `SELECT version,environment_key,placements FROM island_spatial_state WHERE id=?`, accountID).Scan(&state.Version, &state.EnvironmentKey, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), &state.Placements)
}

// readSpatialPlacements 保留提交顺序，未知结果核对不会因存储顺序改变而误判。
func readSpatialPlacements(ctx context.Context, tx *sql.Tx, accountID int64, key string) ([]SpatialPlacement, error) {
	rows, err := tx.QueryContext(ctx, `SELECT instance_id,item_key,space,x_cm,z_cm,rotation FROM island_scene_placements WHERE account_id=? AND scene_key=? ORDER BY position_index,instance_id`, accountID, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	placements := []SpatialPlacement{}
	for rows.Next() {
		var item SpatialPlacement
		if err = rows.Scan(&item.InstanceID, &item.ItemKey, &item.Space, &item.XCM, &item.ZCM, &item.Rotation); err != nil {
			return nil, err
		}
		placements = append(placements, item)
	}
	return placements, rows.Err()
}

// spatialLocations 将尚未保存的海边默认布局也视为真实占用，避免复制免费实例。
func spatialLocations(ctx context.Context, tx *sql.Tx, accountID int64, configuration spatialConfiguration) (map[string]string, error) {
	locations := map[string]string{}
	var persisted bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM island_scene_states WHERE account_id=? AND scene_key=?)`, accountID, configuration.Scene.Key).Scan(&persisted); err != nil {
		return nil, err
	}
	if !persisted {
		state := SpatialState{Version: 1, EnvironmentKey: configuration.DefaultEnvironment, Placements: configuration.DefaultPlacements}
		if err := readLegacySpatialState(ctx, tx, accountID, &state); err != nil {
			return nil, err
		}
		for _, placement := range state.Placements {
			locations[placement.InstanceID] = configuration.Scene.Key
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT instance_id,scene_key FROM island_scene_placements WHERE account_id=?`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var instance, key string
		if err = rows.Scan(&instance, &key); err != nil {
			return nil, err
		}
		locations[instance] = key
	}
	return locations, rows.Err()
}

// ReadSpatial 保留不带场景参数的免费海边入口。
func (service *Service) ReadSpatial(ctx context.Context, principal account.Principal) (SpatialState, error) {
	return service.ReadSpatialScene(ctx, principal, spatialIndex.configuration.Scene.Key)
}

// ReadSpatialScene 读取家庭拥有的独立场景，不在GET中创建状态。
func (service *Service) ReadSpatialScene(ctx context.Context, principal account.Principal, key string) (SpatialState, error) {
	accountID := principal.AccountID
	if key == "" {
		key = spatialIndex.configuration.Scene.Key
	}
	tx, err := service.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SpatialState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, principal, false, service.Now()); err != nil {
		return SpatialState{}, err
	}
	state, err := readSpatialSceneState(ctx, tx, accountID, key)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

// materializeSpatialSeaside 在首次写入时固定默认海边基线，收起后不会再次虚拟生成。
func materializeSpatialSeaside(ctx context.Context, tx *sql.Tx, accountID int64) error {
	key := spatialIndex.configuration.Scene.Key
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM island_scene_states WHERE account_id=? AND scene_key=?)`, accountID, key).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	state, err := readSpatialSceneState(ctx, tx, accountID, key)
	if err != nil {
		return err
	}
	return writeSpatialScene(ctx, tx, accountID, state)
}

// writeSpatialScene 同一事务替换当前场景的整套位置，实例主键约束跨场景唯一。
func writeSpatialScene(ctx context.Context, tx *sql.Tx, accountID int64, state SpatialState) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO island_scene_states(account_id,scene_key,version,environment_key) VALUES(?,?,?,?) ON CONFLICT(account_id,scene_key) DO UPDATE SET version=excluded.version,environment_key=excluded.environment_key`, accountID, state.SceneKey, state.Version, state.EnvironmentKey); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM island_scene_placements WHERE account_id=? AND scene_key=?`, accountID, state.SceneKey); err != nil {
		return err
	}
	for index, item := range state.Placements {
		if _, err := tx.ExecContext(ctx, `INSERT INTO island_scene_placements(account_id,instance_id,scene_key,item_key,space,x_cm,z_cm,rotation,position_index) VALUES(?,?,?,?,?,?,?,?,?)`, accountID, item.InstanceID, state.SceneKey, item.ItemKey, item.Space, item.XCM, item.ZCM, item.Rotation, index); err != nil {
			return err
		}
	}
	return nil
}

// SaveSpatial 在单个写事务复核场景资格、实例占用和几何，再更新目标场景版本。
func (service *Service) SaveSpatial(ctx context.Context, principal account.Principal, input SpatialSaveInput) (SpatialState, error) {
	accountID := principal.AccountID
	tx, err := service.DB.BeginTx(ctx, nil)
	if err != nil {
		return SpatialState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, principal, false, service.Now()); err != nil {
		return SpatialState{}, err
	}
	state, err := readSpatialSceneState(ctx, tx, accountID, input.SceneKey)
	if err != nil {
		return state, err
	}
	if input.ExpectedVersion < 1 || input.ExpectedVersion > core.MaxInteger {
		return SpatialState{}, core.Invalid("expected_version", "INVALID_VALUE")
	}
	if input.ExpectedVersion != state.Version {
		return SpatialState{}, core.VersionConflict(state.Version)
	}
	locations := make(map[string]string, len(state.Inventory))
	for _, item := range state.Inventory {
		locations[item.InstanceID] = item.PlacedSceneKey
	}
	for _, placement := range input.Placements {
		if location := locations[placement.InstanceID]; location != "" && location != input.SceneKey {
			return SpatialState{}, core.Invalid("placements", "PLACED_IN_OTHER_SCENE")
		}
	}
	if err = validateSpatialPlacements(input, state); err != nil {
		return SpatialState{}, err
	}
	state.Version, err = core.Add(state.Version, 1)
	if err != nil {
		return SpatialState{}, err
	}
	if err = materializeSpatialSeaside(ctx, tx, accountID); err != nil {
		return SpatialState{}, err
	}
	state.EnvironmentKey = input.EnvironmentKey
	state.Placements = input.Placements
	if err = writeSpatialScene(ctx, tx, accountID, state); err != nil {
		return SpatialState{}, err
	}
	state, err = readSpatialSceneState(ctx, tx, accountID, input.SceneKey)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

// spatialFindDefinition 只按固定身份查找，商品名称和当前上架状态不影响已有实例。
func spatialFindDefinition(catalog []SpatialDefinition, key string) (SpatialDefinition, bool) {
	for _, definition := range catalog {
		if definition.Key == key {
			return definition, true
		}
	}
	return SpatialDefinition{}, false
}

// spatialPlaced 保存一次已验证的空间计算，后续冲突检查复用同一占地。
type spatialPlaced struct {
	placement  SpatialPlacement  // 原始实例位置。
	definition SpatialDefinition // 当前物件空间能力。
	rect       SpatialRect       // 旋转后的完整占地。
}

// validateSpatialPlacements 允许零栋或一栋主屋，并复核真实实例、完整地形及门口通路。
func validateSpatialPlacements(input SpatialSaveInput, state SpatialState) error {
	invalid := func() error { return core.Invalid("placements", "INVALID_VALUE") }
	var err error
	state.Scene, err = resolveSpatialHouse(state.Scene, input.Placements, state.Catalog)
	if err != nil {
		return err
	}
	if input.SceneKey != state.Scene.Key {
		return core.Invalid("scene_key", "INVALID_VALUE")
	}
	if !slices.Contains(state.Scene.Environments, input.EnvironmentKey) {
		return core.Invalid("environment_key", "INVALID_VALUE")
	}
	if input.Placements == nil || len(input.Placements) > len(state.Inventory) {
		return invalid()
	}
	owned := make(map[string]string, len(state.Inventory))
	for _, item := range state.Inventory {
		owned[item.InstanceID] = item.ItemKey
	}
	seen := make(map[string]bool, len(input.Placements))
	placed := make([]spatialPlaced, 0, len(input.Placements))
	houses := 0
	for _, placement := range input.Placements {
		definition, found := spatialFindDefinition(state.Catalog, placement.ItemKey)
		if !found || owned[placement.InstanceID] != placement.ItemKey || seen[placement.InstanceID] {
			return invalid()
		}
		seen[placement.InstanceID] = true
		if int64(placement.XCM) < -core.MaxInteger || int64(placement.XCM) > core.MaxInteger || int64(placement.ZCM) < -core.MaxInteger || int64(placement.ZCM) > core.MaxInteger {
			return invalid()
		}
		if !slices.Contains(definition.Spaces, placement.Space) || !slices.Contains(definition.Rotations, placement.Rotation) || placement.Rotation < 0 || placement.Rotation > 3 {
			return invalid()
		}
		rect := SpatialPlacementRect(placement, definition.Footprint)
		if placement.Space == SpatialOutdoor {
			for _, fixed := range state.Scene.FixedObjects {
				if fixed.BlocksPlacement && definition.BlocksPlacement && spatialRectsOverlap(rect, SpatialPlacementRect(SpatialPlacement{XCM: fixed.XCM, ZCM: fixed.ZCM, Rotation: fixed.Rotation}, fixed.Footprint)) {
					return invalid()
				}
			}
			if !SpatialFootprintCovered(placement, definition.Footprint, state.Scene.Regions, definition.AllowedTerrain) {
				return invalid()
			}
		} else if placement.Space == SpatialIndoor {
			if state.Scene.House == nil {
				return invalid()
			}
			floor := state.Scene.House.Interior
			if rect.MinXCM < floor.MinXCM || rect.MaxXCM > floor.MaxXCM || rect.MinZCM < floor.MinZCM || rect.MaxZCM > floor.MaxZCM {
				return invalid()
			}
			for _, wall := range state.Scene.House.Walls {
				if spatialRectsOverlap(rect, wall) {
					return invalid()
				}
			}
			if definition.WalkObstacle != nil {
				obstacle := SpatialPlacementRect(placement, *definition.WalkObstacle)
				for _, clearance := range state.Scene.House.InteriorClearances {
					if spatialRectsOverlap(obstacle, clearance) {
						return invalid()
					}
				}
			}
		} else {
			return invalid()
		}
		if definition.Assembly == "house" {
			houses++
			if placement.Space != SpatialOutdoor || placement.Rotation != 0 {
				return invalid()
			}
		}
		if !definition.Movable {
			for _, saved := range state.Placements {
				if saved.InstanceID == placement.InstanceID && saved != placement {
					return invalid()
				}
			}
		}
		placed = append(placed, spatialPlaced{placement, definition, rect})
	}
	if houses > 1 {
		return invalid()
	}
	for index, first := range placed {
		for _, second := range placed[index+1:] {
			if first.placement.Space == second.placement.Space && first.definition.BlocksPlacement && second.definition.BlocksPlacement && spatialRectsOverlap(first.rect, second.rect) {
				return invalid()
			}
		}
		if first.definition.Assembly != "house" {
			continue
		}
		clearance := state.Scene.House.DoorClearance
		x, z := float64(first.placement.XCM), float64(first.placement.ZCM)
		clearance.MinXCM += x
		clearance.MaxXCM += x
		clearance.MinZCM += z
		clearance.MaxZCM += z
		if !spatialRectCovered(clearance, state.Scene.Regions, first.definition.AllowedTerrain) {
			return invalid()
		}
		for _, fixed := range state.Scene.FixedObjects {
			if fixed.WalkObstacle != nil && spatialRectsOverlap(clearance, SpatialPlacementRect(SpatialPlacement{XCM: fixed.XCM, ZCM: fixed.ZCM, Rotation: fixed.Rotation}, *fixed.WalkObstacle)) {
				return invalid()
			}
		}
		for _, other := range placed {
			if other.placement.InstanceID == first.placement.InstanceID || other.placement.Space != SpatialOutdoor || other.definition.WalkObstacle == nil {
				continue
			}
			if spatialRectsOverlap(clearance, SpatialPlacementRect(other.placement, *other.definition.WalkObstacle)) {
				return invalid()
			}
		}
	}
	return nil
}
