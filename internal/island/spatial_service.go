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

// readSpatialState 在调用者快照中读取全部所有权，不连接可变商品或旧二维布局。
func readSpatialState(ctx context.Context, tx *sql.Tx) (SpatialState, error) {
	configuration := spatialConfigurationData()
	state := SpatialState{Version: 1, SceneKey: configuration.Scene.Key, EnvironmentKey: configuration.DefaultEnvironment, Placements: configuration.DefaultPlacements, Inventory: []SpatialOwnedItem{}, Catalog: configuration.Catalog, Scene: configuration.Scene}
	for _, placement := range configuration.DefaultPlacements {
		state.Inventory = append(state.Inventory, SpatialOwnedItem{placement.InstanceID, placement.ItemKey})
	}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT version,scene_key,environment_key,placements FROM island_spatial_state WHERE id=1").Scan(&state.Version, &state.SceneKey, &state.EnvironmentKey, &raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return state, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &state.Placements); err != nil {
			return state, err
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,item_key_snapshot FROM purchases WHERE status='owned' ORDER BY created_at,id")
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
			state.Inventory = append(state.Inventory, item)
		}
	}
	return state, rows.Err()
}

// ReadSpatial 返回新版完整快照，空库只提供默认值而不在读取中写库。
func (service *Service) ReadSpatial(ctx context.Context, principal account.Principal) (SpatialState, error) {
	tx, err := service.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SpatialState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, principal, false, service.Now()); err != nil {
		return SpatialState{}, err
	}
	state, err := readSpatialState(ctx, tx)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

// SaveSpatial 在同一写事务复核权限、所有权与完整空间，再提交整套布局和版本。
func (service *Service) SaveSpatial(ctx context.Context, principal account.Principal, input SpatialSaveInput) (SpatialState, error) {
	tx, err := service.DB.BeginTx(ctx, nil)
	if err != nil {
		return SpatialState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, principal, false, service.Now()); err != nil {
		return SpatialState{}, err
	}
	state, err := readSpatialState(ctx, tx)
	if err != nil {
		return state, err
	}
	if input.ExpectedVersion < 1 || input.ExpectedVersion > core.MaxInteger {
		return SpatialState{}, core.Invalid("expected_version", "INVALID_VALUE")
	}
	if input.ExpectedVersion != state.Version {
		return SpatialState{}, core.VersionConflict(state.Version)
	}
	if err = validateSpatialPlacements(input, state); err != nil {
		return SpatialState{}, err
	}
	version, err := core.Add(state.Version, 1)
	if err != nil {
		return SpatialState{}, err
	}
	raw, err := json.Marshal(input.Placements)
	if err != nil {
		return SpatialState{}, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO island_spatial_state(id,version,scene_key,environment_key,placements) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,scene_key=excluded.scene_key,environment_key=excluded.environment_key,placements=excluded.placements", version, input.SceneKey, input.EnvironmentKey, string(raw))
	if err != nil {
		return SpatialState{}, err
	}
	state.Version = version
	state.SceneKey = input.SceneKey
	state.EnvironmentKey = input.EnvironmentKey
	state.Placements = input.Placements
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

// validateSpatialPlacements 要求完整主屋、真实实例和完整地形覆盖，不要求全营地连通。
func validateSpatialPlacements(input SpatialSaveInput, state SpatialState) error {
	invalid := func() error { return core.Invalid("placements", "INVALID_VALUE") }
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
			if !SpatialFootprintCovered(placement, definition.Footprint, state.Scene.Regions, definition.AllowedTerrain) {
				return invalid()
			}
		} else if placement.Space == SpatialIndoor {
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
	if houses != 1 {
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
