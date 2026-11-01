package island

import (
	_ "embed"
	"encoding/json"
)

//go:embed spatial-scene.json
var spatialSceneJSON []byte

// spatialConfiguration 保持默认布局与场景配置属于同一个固定版本来源。
type spatialConfiguration struct {
	Scene              SpatialScene        `json:"scene"`               // 地形与房屋空间。
	Catalog            []SpatialDefinition `json:"catalog"`             // 已有真实素材的物件。
	DefaultEnvironment string              `json:"default_environment"` // 初始环境。
	DefaultPlacements  []SpatialPlacement  `json:"default_placements"`  // 初始完整布局。
}

// spatialConfigurationData 每次返回独立值，调用者不能改写后续请求的目录。
func spatialConfigurationData() spatialConfiguration {
	var result spatialConfiguration
	if err := json.Unmarshal(spatialSceneJSON, &result); err != nil {
		panic(err)
	}
	return result
}

// SpatialSceneDefinition 返回绘制与保存校验共用的有限空间定义。
func SpatialSceneDefinition() SpatialScene { return spatialConfigurationData().Scene }

// SpatialCatalog 只登记已有受控资源的物件，不提前提供尚无模型的商品。
func SpatialCatalog() []SpatialDefinition { return spatialConfigurationData().Catalog }

// SpatialFind 按稳定物件身份解析已购快照。
func SpatialFind(key string) (SpatialDefinition, bool) {
	return spatialFindDefinition(SpatialCatalog(), key)
}

// SpatialForThumbnail 只认目录登记的缩略图，不从名称或前缀猜测物件。
func SpatialForThumbnail(assetKey string) (SpatialDefinition, bool) {
	for _, item := range SpatialCatalog() {
		if item.ThumbnailAssetKey == assetKey {
			return item, true
		}
	}
	return SpatialDefinition{}, false
}
