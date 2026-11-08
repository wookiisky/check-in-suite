package character

import (
	_ "embed"
	"encoding/json"
)

// wearableColorsJSON 同时供素材制作和外观接口使用。
//
//go:embed wearable-colors.json
var wearableColorsJSON []byte

// WearableColor 是一项可用于服装材质的预设色。
type WearableColor struct {
	Key  string `json:"key"`  // 外观保存使用的稳定身份。
	Name string `json:"name"` // 色块显示名称。
	Hex  string `json:"hex"`  // 色块和材质使用的 sRGB 色值。
}

// WearableColors 返回独立的预设色目录副本。
func WearableColors() []WearableColor {
	var result []WearableColor
	if err := json.Unmarshal(wearableColorsJSON, &result); err != nil {
		panic(err)
	}
	return result
}
