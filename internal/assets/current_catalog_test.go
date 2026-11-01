package assets

import (
	"encoding/json"
	"testing"
)

// TestCurrentCatalogUses3DChoices rejects retired artwork without changing persisted historical reads.
func TestCurrentCatalogUses3DChoices(t *testing.T) {
	items, err := catalog()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		switch item.Kind {
		case KindIcon, KindTitle, KindReward, KindBadge, KindIsland, KindScene, KindModel, KindAnimation, KindWearable, KindCharacter:
		default:
			t.Fatalf("retired kind remains selectable: %s %s", item.Key, item.Kind)
		}
		if (item.Kind == KindIsland || item.Kind == KindScene) && item.extension() != "png" {
			t.Fatalf("retired flat island art remains: %s", item.Key)
		}
		if item.Free && item.Kind != KindIsland {
			t.Fatalf("free capability outside camp thumbnails: %s", item.Key)
		}
	}
	for _, key := range []string{"icon-backpack-v1", "icon-appearance-v1"} {
		item, ok := Get(key)
		if !ok || item.Kind != KindIcon || item.ContentType() != "image/svg+xml" {
			t.Fatalf("missing independent navigation icon: %s", key)
		}
	}
}

// TestCurrentAssetMetadataHasNoCompositionFields checks the actual serialized public shape.
func TestCurrentAssetMetadataHasNoCompositionFields(t *testing.T) {
	data, err := builtin.ReadFile("builtin/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		for _, field := range []string{"wearable_slot", "back_asset_key"} {
			if _, exists := entry[field]; exists {
				t.Fatalf("retired composition field remains in builtin metadata: %s", field)
			}
		}
	}
}
