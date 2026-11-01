package island

import (
	_ "embed"
	"encoding/json"
	"slices"
)

//go:embed spatial-scene.json
var spatialSceneJSON []byte

//go:embed spatial-thumbnail-aliases.json
var spatialThumbnailAliasesJSON []byte

// spatialConfiguration 保持默认布局与场景配置属于同一个固定版本来源。
type spatialConfiguration struct {
	Scene              SpatialScene        `json:"scene"`               // 地形与房屋空间。
	Catalog            []SpatialDefinition `json:"catalog"`             // 已有真实素材的物件。
	DefaultEnvironment string              `json:"default_environment"` // 初始环境。
	DefaultPlacements  []SpatialPlacement  `json:"default_placements"`  // 初始完整布局。
}

// spatialCatalogIndex 只在启动解析一次，索引不向调用者暴露可修改的数据。
type spatialCatalogIndex struct {
	configuration spatialConfiguration // 已解析的受控配置。
	byKey         map[string]int       // 稳定物件身份到目录位置。
	byThumbnail   map[string]int       // 受控缩略图身份到目录位置。
}

var spatialIndex = loadSpatialCatalog()

// loadSpatialCatalog 为频繁的购买与布局校验建立常数时间查询。
func loadSpatialCatalog() spatialCatalogIndex {
	var result spatialCatalogIndex
	if err := json.Unmarshal(spatialSceneJSON, &result.configuration); err != nil {
		panic(err)
	}
	var extra spatialHouseConfiguration
	if err := json.Unmarshal(spatialHousesJSON, &extra); err != nil {
		panic(err)
	}
	result.configuration.Catalog = append(result.configuration.Catalog, extra.Catalog...)
	result.byKey = make(map[string]int, len(result.configuration.Catalog))
	result.byThumbnail = make(map[string]int, len(result.configuration.Catalog))
	for index, item := range result.configuration.Catalog {
		if item.Assembly == "house" && item.HouseKey == "" {
			item.HouseKey = "seaside-house-v1"
			result.configuration.Catalog[index] = item
		}
		if _, exists := result.byKey[item.Key]; exists {
			panic("duplicate spatial item key: " + item.Key)
		}
		if _, exists := result.byThumbnail[item.ThumbnailAssetKey]; exists {
			panic("duplicate spatial thumbnail key: " + item.ThumbnailAssetKey)
		}
		result.byKey[item.Key] = index
		result.byThumbnail[item.ThumbnailAssetKey] = index
	}
	var history struct {
		Aliases map[string]string `json:"aliases"` // 明确登记的历史缩略图与稳定物件关系。
	}
	if err := json.Unmarshal(spatialThumbnailAliasesJSON, &history); err != nil {
		panic(err)
	}
	for thumbnail, key := range history.Aliases {
		index, found := result.byKey[key]
		if !found {
			continue
		}
		if current, exists := result.byThumbnail[thumbnail]; exists && current != index {
			panic("conflicting historical spatial thumbnail key: " + thumbnail)
		}
		result.byThumbnail[thumbnail] = index
	}
	return result
}

// copySpatialDefinition 只复制一个定义的可变字段，查询不复制整个目录。
func copySpatialDefinition(item SpatialDefinition) SpatialDefinition {
	item.Spaces = slices.Clone(item.Spaces)
	item.Rotations = slices.Clone(item.Rotations)
	item.AllowedTerrain = slices.Clone(item.AllowedTerrain)
	if item.WalkObstacle != nil {
		obstacle := *item.WalkObstacle
		item.WalkObstacle = &obstacle
	}
	if item.Interaction != nil {
		interaction := *item.Interaction
		if interaction.Pose != nil {
			pose := *interaction.Pose
			interaction.Pose = &pose
		}
		item.Interaction = &interaction
	}
	return item
}

// SpatialSceneDefinition 返回绘制与保存校验共用的有限空间定义的独立快照。
func SpatialSceneDefinition() SpatialScene {
	data, err := json.Marshal(spatialIndex.configuration.Scene)
	if err != nil {
		panic(err)
	}
	var scene SpatialScene
	if err := json.Unmarshal(data, &scene); err != nil {
		panic(err)
	}
	scene.BackgroundTerrain = "water"
	return scene
}

// SpatialCatalog 只登记已有受控资源的物件，每项均为独立快照。
func SpatialCatalog() []SpatialDefinition {
	result := make([]SpatialDefinition, len(spatialIndex.configuration.Catalog))
	for index, item := range spatialIndex.configuration.Catalog {
		result[index] = copySpatialDefinition(item)
	}
	return result
}

// spatialConfigurationData 为布局流程保留完整配置的独立快照。
func spatialConfigurationData() spatialConfiguration {
	configuration := spatialIndex.configuration
	configuration.Scene = SpatialSceneDefinition()
	configuration.Catalog = SpatialCatalog()
	configuration.DefaultPlacements = slices.Clone(configuration.DefaultPlacements)
	return configuration
}

// SpatialDefaultLayout 提供与首次读取一致的布局，供空库演示种子复用。
func SpatialDefaultLayout() SpatialSaveInput {
	configuration := spatialIndex.configuration
	return SpatialSaveInput{ExpectedVersion: 1, SceneKey: configuration.Scene.Key, EnvironmentKey: configuration.DefaultEnvironment, Placements: slices.Clone(configuration.DefaultPlacements)}
}

// SpatialFind 按稳定物件身份解析已购快照，不扫描完整目录。
func SpatialFind(key string) (SpatialDefinition, bool) {
	index, exists := spatialIndex.byKey[key]
	if !exists {
		return SpatialDefinition{}, false
	}
	return copySpatialDefinition(spatialIndex.configuration.Catalog[index]), true
}

// SpatialForThumbnail 按当前目录及明确历史别名解析，不从名称或前缀猜测物件。
func SpatialForThumbnail(assetKey string) (SpatialDefinition, bool) {
	index, exists := spatialIndex.byThumbnail[assetKey]
	if !exists {
		return SpatialDefinition{}, false
	}
	return copySpatialDefinition(spatialIndex.configuration.Catalog[index]), true
}
