package island

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

//go:embed spatial-scenes.json
var spatialScenesJSON []byte

//go:embed spatial-houses.json
var spatialHousesJSON []byte

// spatialHouseConfiguration 将房型几何与可购买物件和自然场景分开配置。
type spatialHouseConfiguration struct {
	Houses  []SpatialHouse      `json:"houses"`  // 可进入房型的真实几何及剖切节点。
	Catalog []SpatialDefinition `json:"catalog"` // 对应可购买主屋物件。
}

// SpatialSceneDefinitions 返回独立配置快照，调用者不能改变后续请求。
func SpatialSceneDefinitions() []SpatialSceneOption {
	var scenes []SpatialSceneOption
	if err := json.Unmarshal(spatialScenesJSON, &scenes); err != nil {
		panic(err)
	}
	base := SpatialSceneDefinition()
	for i := range scenes {
		scene := &scenes[i]
		if scene.Key == base.Key {
			spawn := scene.Scene.Spawn
			scene.Scene = base
			scene.Scene.Spawn = spawn
		}
		scene.Scene.Name = scene.Name
		scene.Scene.House = nil
		if scene.Scene.FixedObjects == nil {
			scene.Scene.FixedObjects = []SpatialFixedObject{}
		}
		if scene.Scene.ActivityPresentations == nil || len(scene.Scene.ActivityPresentations) == 0 {
			scene.Scene.ActivityPresentations = SpatialSceneDefinition().ActivityPresentations
		}
	}
	return scenes
}

// SpatialSceneFind 通过永久场景身份查找，不连接可变报价或布局。
func SpatialSceneFind(key string) (SpatialSceneOption, bool) {
	for _, scene := range SpatialSceneDefinitions() {
		if scene.Key == key {
			return scene, true
		}
	}
	return SpatialSceneOption{}, false
}

// SpatialHouseFind 读取真实房型；初始房型继续复用原有配置。
func SpatialHouseFind(key string) (SpatialHouse, bool) {
	base := SpatialSceneDefinition().House
	if key == "" || key == "seaside-house-v1" {
		if base == nil {
			return SpatialHouse{}, false
		}
		house := *base
		house.Key = "seaside-house-v1"
		return house, true
	}
	var configuration spatialHouseConfiguration
	if err := json.Unmarshal(spatialHousesJSON, &configuration); err != nil {
		panic(err)
	}
	for _, house := range configuration.Houses {
		if house.Key == key {
			return house, true
		}
	}
	return SpatialHouse{}, false
}

// resolveSpatialHouse 根据目标草稿解析房型，验证不依赖此前保存的房屋。
func resolveSpatialHouse(scene SpatialScene, placements []SpatialPlacement, catalog []SpatialDefinition) (SpatialScene, error) {
	scene.House = nil
	for _, placement := range placements {
		definition, found := spatialFindDefinition(catalog, placement.ItemKey)
		if !found || definition.Assembly != "house" {
			continue
		}
		if scene.House != nil {
			return scene, core.Invalid("placements", "INVALID_VALUE")
		}
		house, found := SpatialHouseFind(definition.HouseKey)
		if !found {
			return scene, core.Invalid("placements", "INVALID_VALUE")
		}
		scene.House = &house
	}
	return scene, nil
}

// spatialSceneOwned 在调用者事务中从订单快照核对永久进入资格。
func spatialSceneOwned(ctx context.Context, tx *sql.Tx, scene SpatialSceneOption) (bool, error) {
	if scene.Free {
		return true, nil
	}
	var owned bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM purchases WHERE type_snapshot='scene' AND scene_key_snapshot=? AND status='owned')`, scene.Key).Scan(&owned)
	return owned, err
}

// ReadSpatialScenes 只读取场景资格，不创建布局或影响其他设备的所在位置。
func (service *Service) ReadSpatialScenes(ctx context.Context, principal account.Principal) ([]SpatialSceneOption, error) {
	tx, err := service.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, principal, false, service.Now()); err != nil {
		return nil, err
	}
	scenes := SpatialSceneDefinitions()
	for i := range scenes {
		scenes[i].Owned, err = spatialSceneOwned(ctx, tx, scenes[i])
		if err != nil {
			return nil, err
		}
	}
	return scenes, tx.Commit()
}

// SpatialHouseDefinitions 供同一草稿在保存前解析目标房型几何。
func SpatialHouseDefinitions() map[string]SpatialHouse {
	houses := map[string]SpatialHouse{}
	base, found := SpatialHouseFind("seaside-house-v1")
	if found {
		houses[base.Key] = base
	}
	var configuration spatialHouseConfiguration
	if err := json.Unmarshal(spatialHousesJSON, &configuration); err != nil {
		panic(err)
	}
	for _, house := range configuration.Houses {
		houses[house.Key] = house
	}
	return houses
}
