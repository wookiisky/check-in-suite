package character

import (
	_ "embed"
	"encoding/json"
)

// previewAnimationCatalogJSON 只存储一份标准身体共用的检查动作目录。
//
//go:embed preview-animation-catalog.json
var previewAnimationCatalogJSON []byte

// PreviewAnimations 返回独立目录副本，调用者只在选中后读取对应模型。
func PreviewAnimations() []Animation {
	var result []Animation
	if err := json.Unmarshal(previewAnimationCatalogJSON, &result); err != nil {
		panic(err)
	}
	return result
}
