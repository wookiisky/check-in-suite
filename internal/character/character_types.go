// Package character owns the immutable 3D body, rig and four-slot wearable catalog.
package character

// Slot identifies one independently replaceable part of the shared character.
type Slot string

const (
	SlotHair            Slot = "hair"             // 发型。
	SlotUpper           Slot = "upper"            // 上衣。
	SlotLower           Slot = "lower"            // 下装。
	SlotShoes           Slot = "shoes"            // 鞋子。
	DefaultCharacterKey      = "kaykit-medium-v1" // 首批统一体型的稳定身份。
)

// Selection names the resolved definitions for the four required slots.
type Selection struct {
	Hair  string `json:"hair"`  // 发型定义。
	Upper string `json:"upper"` // 上衣定义。
	Lower string `json:"lower"` // 下装定义。
	Shoes string `json:"shoes"` // 鞋子定义。
}

// Animation identifies a prepared clip and the immutable file containing it.
type Animation struct {
	Clip     string `json:"clip"`      // GLB 内的动作名称。
	AssetKey string `json:"asset_key"` // 受控资源身份。
	URL      string `json:"url"`       // 同源资源路径。
}

// Definition describes a complete body and its compatible default outfit.
type Definition struct {
	Key           string               `json:"character_key"`   // 身体定义身份。
	Name          string               `json:"name"`            // 目录提供的显示名称。
	RigKey        string               `json:"rig_key"`         // 骨架、层级和绑定姿势的身份。
	ModelAssetKey string               `json:"model_asset_key"` // 身体模型资源身份。
	ModelURL      string               `json:"model_url"`       // 同源身体 GLB。
	Scale         float64              `json:"scale"`           // 米制统一高度的倍率。
	FixedNodes    []string             `json:"fixed_nodes"`     // 始终显示的身体节点。
	BodyRegions   map[string][]string  `json:"body_regions"`    // 由服装覆盖的身体分区。
	Defaults      Selection            `json:"defaults"`        // 每槽免费默认部件。
	Animations    map[string]Animation `json:"animations"`      // 已整理的语义动作。
}

// Wearable describes geometry, body coverage and compatibility independently from ownership.
type Wearable struct {
	Key               string   `json:"wearable_key"`        // 穿戴定义身份。
	Name              string   `json:"name"`                // 目录提供的服装显示名称。
	Slot              Slot     `json:"slot"`                // 唯一所属部位。
	CharacterKey      string   `json:"character_key"`       // 兼容身体身份。
	RigKey            string   `json:"rig_key"`             // 兼容骨架和绑定姿势。
	ModelAssetKey     string   `json:"model_asset_key"`     // 穿戴模型资源身份。
	ModelURL          string   `json:"model_url"`           // 同源 GLB。
	ThumbnailAssetKey string   `json:"thumbnail_asset_key"` // 实际模型渲染的缩略图身份。
	ThumbnailURL      string   `json:"thumbnail_url"`       // 同源缩略图路径。
	Nodes             []string `json:"nodes"`               // 该部件的实际网格。
	Covers            []string `json:"covers"`              // 显示时隐藏的身体区域。
}
