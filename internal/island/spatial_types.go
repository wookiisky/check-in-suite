package island

// SpatialSpace 决定位置使用室外世界坐标还是房屋局部坐标。
type SpatialSpace string

const (
	SpatialOutdoor SpatialSpace = "outdoor" // 室外世界地面。
	SpatialIndoor  SpatialSpace = "indoor"  // 主屋内部地面。
)

// SpatialPoint 使用整数厘米表示地面位置，渲染时除以一百转换为米。
type SpatialPoint struct {
	XCM int `json:"x_cm"` // 世界或局部横坐标。
	ZCM int `json:"z_cm"` // 世界或局部纵深。
}

// SpatialRect 保留完整范围，边界接触不视为重叠。
type SpatialRect struct {
	MinXCM float64 `json:"min_x_cm"` // 左边界；奇数宽度允许半厘米边界。
	MaxXCM float64 `json:"max_x_cm"` // 右边界。
	MinZCM float64 `json:"min_z_cm"` // 后边界。
	MaxZCM float64 `json:"max_z_cm"` // 前边界。
}

// SpatialFootprint 与行走阻挡分别登记，不能用模型包围盒代替业务占地。
type SpatialFootprint struct {
	WidthCM int `json:"width_cm"` // 未旋转的宽度。
	DepthCM int `json:"depth_cm"` // 未旋转的纵深。
}

// SpatialInteraction 给角色提供活动位置，不扩大物件的摆放占地。
type SpatialInteraction struct {
	Activity string `json:"activity"` // 受控活动身份。
	XCM      int    `json:"x_cm"`     // 相对物件的横向位置。
	ZCM      int    `json:"z_cm"`     // 相对物件的纵深位置。
	Rotation int    `json:"rotation"` // 朝向，四分之一圈。
}

// SpatialDefinition 描述一个固定版本物件的空间能力。
type SpatialDefinition struct {
	Key             string              `json:"item_key"`                // 不可复用的物件身份。
	Name            string              `json:"name"`                    // 外化目录中的显示名称。
	Assembly        string              `json:"assembly,omitempty"`      // 组合建筑使用共享房屋定义。
	ModelURL        string              `json:"model_url,omitempty"`     // 单模型物件的受控资源地址。
	Footprint       SpatialFootprint    `json:"footprint"`               // 完整摆放占地。
	WalkObstacle    *SpatialFootprint   `json:"walk_obstacle,omitempty"` // 行走阻挡；房屋由墙体与门洞细化。
	Interaction     *SpatialInteraction `json:"interaction,omitempty"`   // 可选活动位置。
	BlocksPlacement bool                `json:"blocks_placement"`        // 是否与同样声明互斥的物件冲突。
	Movable         bool                `json:"movable"`                 // 用户能否移动。
	Repeatable      bool                `json:"repeatable"`              // 每次购买能否产生新实例。
	Spaces          []SpatialSpace      `json:"spaces"`                  // 可摆放的坐标空间。
	Rotations       []int               `json:"rotations"`               // 支持的四分之一圈朝向。
	AllowedTerrain  []string            `json:"allowed_terrain"`         // 完整占地允许覆盖的室外地形。
}

// SpatialTerrainRegion 是有限简单多边形，同类区域可以共同覆盖完整占地。
type SpatialTerrainRegion struct {
	Terrain string         `json:"terrain"` // 草地、沙滩或水域身份。
	Polygon []SpatialPoint `json:"polygon"` // 有序边界，不重复末尾首点。
}

// SpatialHouseModels 指向正式发布包安装的四个建筑构件。
type SpatialHouseModels struct {
	FloorURL   string `json:"floor_url"`   // 地板模型。
	WallURL    string `json:"wall_url"`    // 实体外墙模型。
	DoorwayURL string `json:"doorway_url"` // 含门洞的外墙模型。
	RoofURL    string `json:"roof_url"`    // 可隐藏的屋顶模型。
}

// SpatialHouse 保持室内地面、门洞、建筑绘制和门外通路使用同一数据。
type SpatialHouse struct {
	Interior      SpatialRect        `json:"interior"`        // 室内完整地面边界。
	FloorHeightCM int                `json:"floor_height_cm"` // 地面相对室外的高度。
	WallHeightCM  int                `json:"wall_height_cm"`  // 外墙高度。
	DoorCenter    SpatialPoint       `json:"door_center"`     // 固定朝向南墙的门中心。
	DoorWidthCM   int                `json:"door_width_cm"`   // 门洞净宽。
	DoorHeightCM  int                `json:"door_height_cm"`  // 门洞净高。
	DoorClearance SpatialRect        `json:"door_clearance"`  // 门外不可封堵的局部区域。
	Models        SpatialHouseModels `json:"models"`          // 建筑绘制素材。
}

// SpatialScene 由服务端与前端共同使用，天空等视觉背景不扩大可保存区域。
type SpatialScene struct {
	Key          string                 `json:"scene_key"`    // 固定版本的整体场景身份。
	Regions      []SpatialTerrainRegion `json:"regions"`      // 有限地形范围。
	Environments []string               `json:"environments"` // 可选环境叠加。
	House        SpatialHouse           `json:"house"`        // 统一房屋空间。
}

// SpatialPlacement 保存地面坐标，摄像机变换不进入持久布局。
type SpatialPlacement struct {
	InstanceID string       `json:"instance_id"` // 已购或免费实例身份。
	ItemKey    string       `json:"item_key"`    // 对应固定版本物件。
	Space      SpatialSpace `json:"space"`       // outdoor 或 indoor。
	XCM        int          `json:"x_cm"`        // 地面横坐标，整数厘米。
	ZCM        int          `json:"z_cm"`        // 地面纵深，整数厘米。
	Rotation   int          `json:"rotation"`    // 四分之一圈，零到三。
}

// SpatialOwnedItem 从真实所有权解析，不受商店订单分页影响。
type SpatialOwnedItem struct {
	InstanceID string `json:"instance_id"` // 布局复用的实例身份。
	ItemKey    string `json:"item_key"`    // 允许摆放的物件定义。
}

// SpatialState 是一个数据库快照中的新版布局与完整库存。
type SpatialState struct {
	Version        int64               `json:"version"`         // 独立的乐观并发版本。
	SceneKey       string              `json:"scene_key"`       // 整体场景身份。
	EnvironmentKey string              `json:"environment_key"` // 环境叠加，不作摆放物件。
	Placements     []SpatialPlacement  `json:"placements"`      // 当前保存的完整布局。
	Inventory      []SpatialOwnedItem  `json:"inventory"`       // 所有可摆放实例。
	Catalog        []SpatialDefinition `json:"catalog"`         // 当前固定版本物件目录。
	Scene          SpatialScene        `json:"scene"`           // 地形与房屋空间数据。
}

// SpatialSaveInput 用一次完整提交保存草稿，不接受缺省替代清空。
type SpatialSaveInput struct {
	ExpectedVersion int64              `json:"expected_version"` // 用户读取的版本。
	SceneKey        string             `json:"scene_key"`        // 目标场景身份。
	EnvironmentKey  string             `json:"environment_key"`  // 目标环境。
	Placements      []SpatialPlacement `json:"placements"`       // 完整布局，不能为空值。
}
