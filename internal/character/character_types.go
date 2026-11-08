// Package character owns the immutable 3D body, rig and six-slot wearable catalog.
package character

// Slot identifies one independently replaceable part of the shared character.
type Slot string

const (
	SlotFace            Slot = "face"                  // 形象。
	SlotHead            Slot = "head"                  // 头部。
	SlotBack            Slot = "back"                  // 背部。
	SlotUpper           Slot = "upper"                 // 上衣。
	SlotLower           Slot = "lower"                 // 下装。
	SlotShoes           Slot = "shoes"                 // 鞋子。
	DefaultCharacterKey      = "kaykit-medium-v1"      // 首批统一体型的稳定身份。
	DefaultBodyKey           = "kaykit-medium-body-v1" // 统一身体比例、骨架绑定姿势及六槽接缝的规格。
)

// Selection names the resolved definitions for the six required slots.
type Selection struct {
	Face  string `json:"face"`  // 形象定义。
	Head  string `json:"head"`  // 头部定义。
	Back  string `json:"back"`  // 背部定义。
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
	PreviewAnimations []Animation          `json:"preview_animations,omitempty"`  // 独立预览使用的原始动作，按需读取而不进入营地玩法。
	Key               string               `json:"character_key"`                 // 身体定义身份。
	BodyKey           string               `json:"body_key"`                      // 可共用服装的统一身体规格。
	Name              string               `json:"name"`                          // 目录提供的显示名称。
	Provider          string               `json:"provider,omitempty"`            // 素材官方来源。
	PackKey           string               `json:"pack_key,omitempty"`            // 来源素材包稳定身份。
	ThumbnailAssetKey string               `json:"thumbnail_asset_key,omitempty"` // 实际人物渲染缩略图。
	ThumbnailURL      string               `json:"thumbnail_url,omitempty"`       // 同源缩略图路径。
	RigKey            string               `json:"rig_key"`                       // 骨架、层级和绑定姿势的身份。
	ModelAssetKey     string               `json:"model_asset_key"`               // 身体模型资源身份。
	ModelURL          string               `json:"model_url"`                     // 同源身体 GLB。
	Scale             float64              `json:"scale"`                         // 米制统一高度的倍率。
	FixedNodes        []string             `json:"fixed_nodes"`                   // 始终显示的身体节点。
	BodyRegions       map[string][]string  `json:"body_regions"`                  // 由服装覆盖的身体分区。
	Defaults          Selection            `json:"defaults"`                      // 每槽免费默认部件。
	Animations        map[string]Animation `json:"animations"`                    // 已整理的语义动作。
}

// Wearable describes geometry, body coverage and compatibility independently from ownership.
type Wearable struct {
	DyeMaterial       string              `json:"dye_material,omitempty"`      // GLB 内用于切换底色的材质名。
	DefaultColorKey   string              `json:"default_color_key,omitempty"` // 素材底色对应的预设身份。
	Regions           map[string][]string `json:"regions,omitempty"`           // 可被其他穿戴部件覆盖的子区域，例如形象的头皮。
	Empty             bool                `json:"empty,omitempty"`             // 明确不穿戴的默认项允许没有网格，形象必须有几何。
	Key               string              `json:"wearable_key"`                // 穿戴定义身份。
	BodyKey           string              `json:"body_key"`                    // 适配身体规格，不以角色外观身份限制共用。
	Provider          string              `json:"provider,omitempty"`          // 素材官方来源。
	PackKey           string              `json:"pack_key,omitempty"`          // 来源素材包稳定身份。
	Name              string              `json:"name"`                        // 目录提供的服装显示名称。
	Slot              Slot                `json:"slot"`                        // 唯一所属部位。
	CharacterKey      string              `json:"character_key"`               // 兼容身体身份。
	RigKey            string              `json:"rig_key"`                     // 兼容骨架和绑定姿势。
	ModelAssetKey     string              `json:"model_asset_key"`             // 穿戴模型资源身份。
	ModelURL          string              `json:"model_url"`                   // 同源 GLB。
	ThumbnailAssetKey string              `json:"thumbnail_asset_key"`         // 实际模型渲染的缩略图身份。
	ThumbnailURL      string              `json:"thumbnail_url"`               // 同源缩略图路径。
	Nodes             []string            `json:"nodes"`                       // 该部件的实际网格。
	Covers            []string            `json:"covers"`                      // 显示时隐藏的身体区域。
}

// Slots returns the complete order used for appearance validation and defaults.
func Slots() []Slot { return []Slot{SlotFace, SlotHead, SlotUpper, SlotLower, SlotShoes, SlotBack} }

// ForSlot resolves a declared default without deriving identities from names.
func (selection Selection) ForSlot(slot Slot) string {
	switch slot {
	case SlotFace:
		return selection.Face
	case SlotHead:
		return selection.Head
	case SlotUpper:
		return selection.Upper
	case SlotLower:
		return selection.Lower
	case SlotShoes:
		return selection.Shoes
	case SlotBack:
		return selection.Back
	default:
		return ""
	}
}
