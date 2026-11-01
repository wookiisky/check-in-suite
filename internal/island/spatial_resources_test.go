package island_test

import (
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestSpatialCatalogRegisteredResources 防止可购买目录指向缺失模型或错误缩略图种类。
func TestSpatialCatalogRegisteredResources(t *testing.T) {
	seen := map[string]bool{}
	for _, item := range island.SpatialCatalog() {
		t.Run(item.Key, func(t *testing.T) {
			if seen[item.Key] {
				t.Fatalf("duplicate item identity %s", item.Key)
			}
			seen[item.Key] = true
			thumbnail, ok := assets.Get(item.ThumbnailAssetKey)
			if !ok || thumbnail.Kind != assets.KindIsland || thumbnail.URL != item.ThumbnailURL || thumbnail.Free != item.Free {
				t.Fatalf("unregistered thumbnail %+v", item)
			}
			if item.ModelURL != "" {
				model, ok := assets.Get(strings.TrimPrefix(item.ModelURL, "/api/v1/assets/"))
				if !ok || model.Kind != assets.KindModel || model.URL != item.ModelURL {
					t.Fatalf("unregistered model %s", item.ModelURL)
				}
			}
		})
	}
	for activity, presentation := range island.SpatialSceneDefinition().ActivityPresentations {
		if presentation.Attachment == nil {
			continue
		}
		model, ok := assets.Get(strings.TrimPrefix(presentation.Attachment.ModelURL, "/api/v1/assets/"))
		if !ok || model.Kind != assets.KindModel {
			t.Fatalf("unregistered %s attachment", activity)
		}
	}
}
