package character

// actionBinding binds an actual clip and its optional camp presentation to one rig.
type actionBinding struct {
	Clip         string                `json:"clip"`         // GLB 内的动作片段。
	AssetKey     string                `json:"asset_key"`    // 不可覆写的 GLB 版本。
	Presentation *ActivityPresentation `json:"presentation"` // 与该片段一起校准的表演参数。
}

// ActivityPresentation tells the camp how to present an action already bound to the rig.
type ActivityPresentation struct {
	Action     string              `json:"action"`               // 与人物动作表共用的语义身份。
	Attachment *ActivityAttachment `json:"attachment,omitempty"` // 随片段使用的骨骼挂件。
	Ball       *BallTiming         `json:"ball,omitempty"`       // 触球片段使用的运动参数。
}

// ActivityAttachment defines a versioned model and its transform relative to the named bone.
type ActivityAttachment struct {
	ModelAssetKey string    `json:"model_asset_key"` // 道具 GLB 版本。
	ModelURL      string    `json:"model_url"`       // 从版本身份派生的加载地址。
	Bone          string    `json:"bone"`            // 渲染器读取到的骨骼名。
	Matrix        []float64 `json:"matrix"`          // 列主序四乘四局部变换。
}

// BallTiming anchors the ball motion to the actual kick clip.
type BallTiming struct {
	PeriodSeconds   float64    `json:"period_seconds"`   // 动作循环时长。
	ContactSeconds  float64    `json:"contact_seconds"`  // 从片段首帧到触球的时间。
	ContactPosition [3]float64 `json:"contact_position"` // 角色根节点局部坐标，单位为米。
}

// assetURL builds the common immutable resource path from the catalog identity.
func assetURL(key string) string { return "/api/v1/assets/" + key }

// Presentation returns the authored binding for the shared camp rig.
func Presentation(key string) (ActivityPresentation, bool) {
	catalog := readCatalog()
	for _, body := range catalog.Characters {
		if body.Key != DefaultCharacterKey {
			continue
		}
		binding := catalog.AnimationSets[body.RigKey][key]
		if binding.Presentation == nil {
			return ActivityPresentation{}, false
		}
		result := *binding.Presentation
		result.Action = key
		if result.Attachment != nil {
			result.Attachment.ModelURL = assetURL(result.Attachment.ModelAssetKey)
		}
		return result, true
	}
	return ActivityPresentation{}, false
}
