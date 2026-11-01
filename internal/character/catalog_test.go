package character

import "testing"

// 新人物目录以稳定的身体、骨架和四槽定义提供外观兼容依据。
func TestCatalogDefaultAndWearableCompatibility(t *testing.T) {
	definition, ok := Get(DefaultCharacterKey)
	if !ok || definition.RigKey == "" || definition.ModelAssetKey == "" || definition.ModelURL == "" || definition.Scale <= 0 {
		t.Fatalf("missing usable default character: %#v", definition)
	}
	for slot, key := range map[Slot]string{SlotHair: definition.Defaults.Hair, SlotUpper: definition.Defaults.Upper, SlotLower: definition.Defaults.Lower, SlotShoes: definition.Defaults.Shoes} {
		wearable, exists := GetWearable(key)
		if !exists || wearable.Slot != slot || wearable.CharacterKey != definition.Key || wearable.RigKey != definition.RigKey || len(wearable.Nodes) == 0 {
			t.Fatalf("invalid default %s: %#v", slot, wearable)
		}
	}
	if _, exists := Get("missing"); exists {
		t.Fatal("unknown character accepted")
	}
	if _, exists := GetWearable("missing"); exists {
		t.Fatal("unknown wearable accepted")
	}
	if len(Definitions()) == 0 || len(Wearables()) == 0 {
		t.Fatal("catalog empty")
	}
}
