package character

import (
	"slices"
	"testing"
)

// 形象选择只提供四款，基础人形默认使用微笑脸。
func TestFaceCatalog(t *testing.T) {
	var keys []string
	for _, item := range Wearables() {
		if item.Slot == SlotFace {
			keys = append(keys, item.Key)
		}
	}
	want := []string{
		"face-kaykit-adventurers-ranger",
		"face-kaykit-legacy-skeleton-minion",
		"face-skeleton-default-v1",
		"face-kaykit-skeletons-mage",
	}
	if !slices.Equal(keys, want) {
		t.Fatalf("face catalog = %v, want %v", keys, want)
	}
	if body, ok := Get(DefaultCharacterKey); !ok || body.Defaults.Face != want[0] {
		t.Fatalf("default human face = %q, want %q", body.Defaults.Face, want[0])
	}
}

// 新人物目录以稳定的身体、骨架和六槽定义提供外观兼容依据。
func TestCatalogDefaultAndWearableCompatibility(t *testing.T) {
	definition, ok := Get(DefaultCharacterKey)
	if !ok || definition.RigKey == "" || definition.ModelAssetKey == "" || definition.ModelURL == "" || definition.Scale <= 0 {
		t.Fatalf("missing usable default character: %#v", definition)
	}
	if len(Definitions()) != 2 {
		t.Fatalf("expected only basic human and skeleton, got %d", len(Definitions()))
	}
	for _, body := range Definitions() {
		for _, slot := range Slots() {
			wearable, exists := GetWearable(body.Defaults.ForSlot(slot))
			if !exists || wearable.Slot != slot || wearable.BodyKey != body.BodyKey || wearable.RigKey != body.RigKey || (len(wearable.Nodes) == 0 && (!wearable.Empty || slot == SlotFace)) {
				t.Fatalf("invalid default %s for %s: %#v", slot, body.Key, wearable)
			}
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
