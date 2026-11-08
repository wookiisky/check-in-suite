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
	if definition.Sellable {
		t.Fatal("the default character must not be sold")
	}
	for _, body := range Definitions() {
		for _, slot := range Slots() {
			wearable, exists := GetWearable(body.Defaults.ForSlot(slot))
			if !exists || wearable.Sellable || wearable.Slot != slot || wearable.BodyKey != body.BodyKey || wearable.RigKey != body.RigKey || (len(wearable.Nodes) == 0 && (!wearable.Empty || slot == SlotFace)) {
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

// 营地动作直接引用共用骨架上的片段，挂点和触球数据随片段读取。
func TestCatalogCampPresentations(t *testing.T) {
	for _, key := range []string{"read", "exercise", "play"} {
		presentation, ok := Presentation(key)
		if !ok || presentation.Action != key {
			t.Fatalf("missing camp presentation for %s: %#v", key, presentation)
		}
		for _, body := range Definitions() {
			if animation := body.Animations[key]; animation.Clip == "" || animation.URL == "" {
				t.Fatalf("body %s cannot play %s: %#v", body.Key, key, animation)
			}
		}
	}
	if _, ok := Presentation("idle"); ok {
		t.Fatal("a generic animation must not automatically register a camp presentation")
	}
	if _, ok := Presentation("future"); ok {
		t.Fatal("an unbound presentation must not be synthesized")
	}
	book, _ := Presentation("read")
	if book.Attachment == nil || book.Attachment.ModelAssetKey == "" || book.Attachment.ModelURL == "" || len(book.Attachment.Matrix) != 16 {
		t.Fatalf("read has no complete book binding: %#v", book.Attachment)
	}
	book.Attachment.Matrix[0] = 100
	fresh, _ := Presentation("read")
	if fresh.Attachment.Matrix[0] == 100 {
		t.Fatal("caller changed the immutable attachment binding")
	}
	play, _ := Presentation("play")
	if play.Ball == nil || play.Ball.ContactSeconds <= 0 || play.Ball.ContactSeconds >= play.Ball.PeriodSeconds {
		t.Fatalf("play has no valid contact timing: %#v", play.Ball)
	}
}
