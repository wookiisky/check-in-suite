package assets

import (
	"io/fs"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// 两种基础身体共用六槽契约，职业与来源人物不能再成为基础身体。
func TestCharacterCatalogContainsOnlyBaseBodiesAndSixSlots(t *testing.T) {
	bodies := character.Definitions()
	if len(bodies) != 2 {
		t.Fatalf("expected only human and skeleton bodies, got %d", len(bodies))
	}
	wanted := map[string]bool{"kaykit-medium-v1": false, "kaykit-skeleton-v1": false}
	slots := []character.Slot{"face", "head", "upper", "lower", "shoes", "back"}
	for _, body := range bodies {
		if _, ok := wanted[body.Key]; !ok || body.Provider != "kaykit" {
			t.Fatalf("unexpected base body: %#v", body)
		}
		wanted[body.Key] = true
		for _, slot := range slots {
			key := body.Defaults.ForSlot(slot)
			wearable, ok := character.GetWearable(key)
			if !ok || wearable.Slot != slot || wearable.BodyKey != body.BodyKey || wearable.RigKey != body.RigKey {
				t.Fatalf("invalid %s default for %s: %q", slot, body.Key, key)
			}
			if slot == "face" && (wearable.Empty || len(wearable.Nodes) == 0) {
				t.Fatalf("base body has no complete face: %s", body.Key)
			}
			if (slot == "head" || slot == "back") && !wearable.Empty {
				t.Fatalf("base body must allow bare head and empty back: %s %s", body.Key, slot)
			}
		}
	}
	for key, found := range wanted {
		if !found {
			t.Errorf("missing base body: %s", key)
		}
	}
	for _, wearable := range character.Wearables() {
		if wearable.Provider == "kenney" || wearable.Slot == "hair" {
			t.Fatalf("retired character wearable remains: %#v", wearable)
		}
		validSlot := false
		for _, slot := range slots {
			validSlot = validSlot || wearable.Slot == slot
		}
		if !validSlot {
			t.Fatalf("unknown wearable slot: %s", wearable.Slot)
		}
		if wearable.Empty && (wearable.Slot == "face" || len(wearable.Nodes) != 0 || len(wearable.Covers) != 0 || len(wearable.Regions) != 0) {
			t.Fatalf("empty wearable changes visible geometry: %#v", wearable)
		}
		if !wearable.Empty && len(wearable.Nodes) == 0 {
			t.Fatalf("wearable has no delivered geometry: %s", wearable.Key)
		}
	}
}

// 退役人物退出嵌入文件，Kenney营地物件仍保留，目录之外不能残留随包发布的旧文件。
func TestCurrentAssetsRemoveKenneyCharactersAndRetainStaticItems(t *testing.T) {
	items, err := catalog()
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]bool{"catalog.json": true}
	staticModels, staticPictures := 0, 0
	for _, item := range items {
		files[item.Key+"."+item.extension()] = true
		if item.Provider != "kenney" {
			continue
		}
		if item.Kind == KindCharacter || item.Kind == KindWearable {
			t.Fatalf("Kenney character art remains selectable: %s", item.Key)
		}
		if item.Kind == KindIsland {
			staticPictures++
		}
		if item.Kind != KindModel {
			continue
		}
		data, err := builtin.ReadFile("builtin/" + item.Key + ".glb")
		if err != nil {
			t.Fatal(err)
		}
		if len(readGraphicsGLB(t, data).Skins) != 0 {
			t.Fatalf("retired Kenney skinned character remains embedded: %s", item.Key)
		}
		staticModels++
	}
	if staticModels == 0 || staticPictures == 0 {
		t.Fatal("Kenney static camp models and thumbnails must be retained")
	}
	entries, err := fs.ReadDir(builtin, "builtin")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() && !files[entry.Name()] {
			t.Errorf("uncataloged asset is still embedded in the release: %s", entry.Name())
		}
	}
}
