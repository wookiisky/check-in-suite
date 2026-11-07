package character

import "testing"

// 所有人物与服装必须引用同一个身体规格，旧服装也必须能解析其身体身份。
func TestCatalogUsesSharedBodySpecification(t *testing.T) {
	for _, definition := range Definitions() {
		if definition.BodyKey != DefaultBodyKey {
			t.Fatalf("character %s has body %q", definition.Key, definition.BodyKey)
		}
		for _, slot := range Slots() {
			key := definition.Defaults.ForSlot(slot)
			wearable, ok := GetWearable(key)
			if !ok || wearable.BodyKey != definition.BodyKey || wearable.RigKey != definition.RigKey {
				t.Fatalf("incompatible default for %s: %#v", definition.Key, wearable)
			}
		}
	}
}

// 调用者修改返回值不得污染缓存，尤其是身体分区与动作映射。
func TestCatalogReturnsIndependentDefinitions(t *testing.T) {
	first, _ := Get(DefaultCharacterKey)
	first.FixedNodes[0] = "changed"
	first.BodyRegions["torso"][0] = "changed"
	first.Animations["idle"] = Animation{Clip: "changed"}
	second, _ := Get(DefaultCharacterKey)
	if second.FixedNodes[0] == "changed" || second.BodyRegions["torso"][0] == "changed" || second.Animations["idle"].Clip == "changed" {
		t.Fatal("caller changed immutable character catalog")
	}
}
