package character

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// 共享动作目录与实际已加工清单一致，人物定义只保留已有兼容动作。
func TestPreviewAnimationCatalogMatchesDelivery(t *testing.T) {
	data, err := os.ReadFile("../assets/provider-animation-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Animations []Animation `json:"animations"` // 实际交付动作。
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if animations := PreviewAnimations(); len(animations) == 0 || !reflect.DeepEqual(animations, manifest.Animations) {
		t.Fatal("shared animations do not match delivered clips")
	}
}

// 每个调用者取得独立切片，不能修改下一次请求读取的内置目录。
func TestPreviewAnimationCatalogReturnsFreshDefinitions(t *testing.T) {
	first := PreviewAnimations()
	original := first[0]
	first[0].Clip = "changed"
	if next := PreviewAnimations(); next[0] != original {
		t.Fatal("one caller changed the shared animation catalog")
	}
}
