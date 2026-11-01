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
	Activity string                  `json:"activity"`       // read、run 或 ball 的业务资格身份。
	XCM      int                     `json:"x_cm"`           // 相对物件的可达横向位置。
	ZCM      int                     `json:"z_cm"`           // 相对物件的可达纵深位置。
	Rotation int                     `json:"rotation"`       // 到达后的朝向，四分之一圈。
	Pose     *SpatialInteractionPose `json:"pose,omitempty"` // 到达后使用的表演根位置。
}

// SpatialInteractionPose 把可达地面点与坐姿等表演根偏移分开。
type SpatialInteractionPose struct {
	XCM      int `json:"x_cm"`     // 相对物件横向厘米。
	YCM      int `json:"y_cm"`     // 相对物件地面高度厘米。
	ZCM      int `json:"z_cm"`     // 相对物件纵深厘米。
	Rotation int `json:"rotation"` // 表演朝向，四分之一圈。
}

// SpatialDefinition 描述一个固定版本物件的空间能力。
type SpatialDefinition struct {
	Key               string              `json:"item_key"`                // 不可复用的物件身份。
	Name              string              `json:"name"`                    // 外化目录中的显示名称。
	Provider          string              `json:"provider,omitempty"`      // 素材官方来源，用于浏览筛选。
	PackKey           string              `json:"pack_key,omitempty"`      // 来源包身份，与物件版本分开。
	PackName          string              `json:"pack_name,omitempty"`     // 官方素材包的展示名称。
	Category          string              `json:"category,omitempty"`      // 已审核完整摆设的用途分类。
	ThumbnailAssetKey string              `json:"thumbnail_asset_key"`     // 商品与库存使用的受控缩略图身份。
	ThumbnailURL      string              `json:"thumbnail_url"`           // 缩略图受控资源地址。
	CoinPrice         int64               `json:"coin_price"`              // 初始化商品的金币价格。
	DiamondPrice      int64               `json:"diamond_price"`           // 初始化商品的钻石价格。
	Free              bool                `json:"free"`                    // 明确的免费初始款，不创建售卖入口。
	Assembly          string              `json:"assembly,omitempty"`      // 组合建筑使用共享房屋定义。
	HouseKey          string              `json:"house_key,omitempty"`     // 房型身份与场景、物品版本分离。
	ModelURL          string              `json:"model_url,omitempty"`     // 单模型物件的受控资源地址。
	Footprint         SpatialFootprint    `json:"footprint"`               // 完整摆放占地。
	WalkObstacle      *SpatialFootprint   `json:"walk_obstacle,omitempty"` // 行走阻挡；房屋由墙体与门洞细化。
	Interaction       *SpatialInteraction `json:"interaction,omitempty"`   // 可选活动位置。
	BlocksPlacement   bool                `json:"blocks_placement"`        // 是否与同样声明互斥的物件冲突。
	Movable           bool                `json:"movable"`                 // 用户能否移动。
	Repeatable        bool                `json:"repeatable"`              // 每次购买能否产生新实例。
	Spaces            []SpatialSpace      `json:"spaces"`                  // 可摆放的坐标空间。
	Rotations         []int               `json:"rotations"`               // 支持的四分之一圈朝向。
	AllowedTerrain    []string            `json:"allowed_terrain"`         // 完整占地允许覆盖的室外地形。
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

// SpatialEntryHeight 将真实入口平台和台阶的局部高度按纵深记录。
type SpatialEntryHeight struct {
	ZCM float64 `json:"z_cm"` // 房屋局部纵深，按递增顺序排列。
	YCM float64 `json:"y_cm"` // 对应地面上方高度，包含实际倒角。
}

// SpatialHouse 保持室内地面、门洞、建筑绘制和门外通路使用同一数据。
type SpatialHouse struct {
	EntryHeightProfile []SpatialEntryHeight `json:"entry_height_profile,omitempty"` // 门前平台和台阶高度；与通路范围分别配置。
	Key                string               `json:"house_key,omitempty"`            // 稳定房型身份。
	ModelURL           string               `json:"model_url,omitempty"`            // 可按节点剖切的自包含房屋GLB。
	RoofNodes          []string             `json:"roof_nodes,omitempty"`           // 室内视角隐藏的屋顶部件。
	WallNodes          map[string][]string  `json:"wall_nodes,omitempty"`           // 四个方向分别隐藏的墙面及附属部件。
	Interior           SpatialRect          `json:"interior"`                       // 室内完整地面边界。
	FloorHeightCM      int                  `json:"floor_height_cm"`                // 地面相对室外的高度。
	WallHeightCM       int                  `json:"wall_height_cm"`                 // 外墙高度。
	DoorCenter         SpatialPoint         `json:"door_center"`                    // 固定朝向南墙的门中心。
	DoorWidthCM        int                  `json:"door_width_cm"`                  // 门洞净宽。
	DoorHeightCM       int                  `json:"door_height_cm"`                 // 门洞净高。
	DoorClearance      SpatialRect          `json:"door_clearance"`                 // 门外不可封堵的局部区域。
	Models             *SpatialHouseModels  `json:"models,omitempty"`               // 旧房型建筑构件；完整模型房型使用model_url。
	Walls              []SpatialRect        `json:"walls"`                          // 实际落地外墙与固定隔墙，门洞留空。
	InteriorClearances []SpatialRect        `json:"interior_clearances"`            // 室内门口通路，不允许行走障碍封堵。
}

// SpatialActivityAttachment 把活动道具固定到正式人物骨骼。
type SpatialActivityAttachment struct {
	ModelURL string      `json:"model_url"` // 受控道具模型。
	Bone     string      `json:"bone"`      // GLTFLoader 加载后的骨骼名称。
	Matrix   [16]float64 `json:"matrix"`    // Three.js 列优先局部变换矩阵，单位米。
}

// SpatialActivityPresentation 显式关联业务活动与实际动作，不从物件名字推断。
type SpatialActivityPresentation struct {
	Action     string                     `json:"action"`               // 正式人物支持的语义动作。
	Attachment *SpatialActivityAttachment `json:"attachment,omitempty"` // 活动期间可选道具。
}

// SpatialScene 由服务端与前端共同使用，天空等视觉背景不扩大可保存区域。
type SpatialScene struct {
	BackgroundTerrain     string                                 `json:"background_terrain,omitempty"` // 可选远景地形；仅海边延伸远海。
	Key                   string                                 `json:"scene_key"`                    // 固定版本的整体场景身份。
	Regions               []SpatialTerrainRegion                 `json:"regions"`                      // 有限地形范围。
	Environments          []string                               `json:"environments"`                 // 可选环境叠加。
	House                 *SpatialHouse                          `json:"house"`                        // 按当前布局解析的房型；无房时为空。
	Name                  string                                 `json:"name,omitempty"`               // 场景显示名称。
	Spawn                 SpatialPoint                           `json:"spawn"`                        // 新进入场景的合法室外落点。
	FixedObjects          []SpatialFixedObject                   `json:"fixed_objects"`                // 视觉和空间判断共用的固定景物。
	ActivityPresentations map[string]SpatialActivityPresentation `json:"activity_presentations"`       // read/run/ball 的表演。
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
	InstanceID     string `json:"instance_id"`                // 布局复用的实例身份。
	ItemKey        string `json:"item_key"`                   // 允许摆放的物件定义。
	PlacedSceneKey string `json:"placed_scene_key,omitempty"` // 当前占用场景；空值表示已收起。
}

// SpatialState 是一个数据库快照中的新版布局与完整库存。
type SpatialState struct {
	Version        int64                   `json:"version"`         // 独立的乐观并发版本。
	SceneKey       string                  `json:"scene_key"`       // 整体场景身份。
	EnvironmentKey string                  `json:"environment_key"` // 环境叠加，不作摆放物件。
	Placements     []SpatialPlacement      `json:"placements"`      // 当前保存的完整布局。
	Inventory      []SpatialOwnedItem      `json:"inventory"`       // 所有可摆放实例。
	Catalog        []SpatialDefinition     `json:"catalog"`         // 当前固定版本物件目录。
	Scene          SpatialScene            `json:"scene"`           // 地形与房屋空间数据。
	Houses         map[string]SpatialHouse `json:"houses"`          // 供草稿换房解析的完整房型目录。
}

// SpatialSaveInput 用一次完整提交保存草稿，不接受缺省替代清空。
type SpatialSaveInput struct {
	ExpectedVersion int64              `json:"expected_version"` // 用户读取的版本。
	SceneKey        string             `json:"scene_key"`        // 目标场景身份。
	EnvironmentKey  string             `json:"environment_key"`  // 目标环境。
	Placements      []SpatialPlacement `json:"placements"`       // 完整布局，不能为空值。
}

// SpatialFixedObject 将固定景物模型、摆放与行走阻挡写在同一配置中。
type SpatialFixedObject struct {
	Key             string            `json:"key"`                     // 场景内唯一身份。
	ModelURL        string            `json:"model_url"`               // 正式自包含模型。
	XCM             int               `json:"x_cm"`                    // 世界横向位置。
	ZCM             int               `json:"z_cm"`                    // 世界纵深位置。
	Rotation        int               `json:"rotation"`                // 四分之一圈朝向。
	Scale           float64           `json:"scale"`                   // 相对模型原始米制比例。
	Footprint       SpatialFootprint  `json:"footprint"`               // 完整摆放占地。
	WalkObstacle    *SpatialFootprint `json:"walk_obstacle,omitempty"` // 行走阻挡。
	BlocksPlacement bool              `json:"blocks_placement"`        // 是否禁止在完整占地内布置。
}

// SpatialSceneOption 表示永久空间资格及绘制、校验共用的受控定义。
type SpatialSceneOption struct {
	Key                string       `json:"scene_key"`           // 永久空间身份，与资源版本分开。
	Name               string       `json:"name"`                // 外化配置中的场景名称。
	ThumbnailAssetKey  string       `json:"thumbnail_asset_key"` // 商店及场景入口缩略图。
	ThumbnailURL       string       `json:"thumbnail_url"`       // 同源缩略图地址。
	Free               bool         `json:"free"`                // 无需购买的初始场景。
	Owned              bool         `json:"owned"`               // 当前家庭的永久进入资格。
	DefaultEnvironment string       `json:"default_environment"` // 首次读取的光照。
	Scene              SpatialScene `json:"scene"`               // 不含布局实例的共享空间定义。
}
