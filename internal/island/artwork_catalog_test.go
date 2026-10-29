package island_test

import (
	"encoding/json"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// 新素材具备可摆放定义，但不预设商品、互动或房屋能力。
func TestSupplementalArtworkDefinitions(t *testing.T) {
	for _, key := range []string{"flowers", "mushrooms", "rocks", "fence", "bench", "lantern", "tent", "fountain", "swing", "windmill"} {
		t.Run(key, func(t *testing.T) {
			assetKey := "island-" + key + "-v1"
			definition, ok := island.ForAsset(assetKey)
			if !ok || definition.Category != "decoration" || definition.Model != assetKey || !definition.Movable || !definition.Repeatable || definition.Width <= 0 || definition.Depth <= 0 || definition.Activity != "" || definition.Animation != "" {
				t.Fatalf("missing static placeable definition for %s: %#v", assetKey, definition)
			}
			body, err := json.Marshal(definition)
			if err != nil {
				t.Fatal(err)
			}
			var metadata map[string]any
			if err := json.Unmarshal(body, &metadata); err != nil {
				t.Fatal(err)
			}
			if metadata["catalog_only"] != true {
				t.Fatalf("artwork would become an initial offer: %s", body)
			}
		})
	}
}
