package island

import "testing"

// 目录查询交付独立快照，调用者不能改变后续请求或同一物件的其他查询。
func TestSpatialCatalogSnapshotsDoNotShareMutableState(t *testing.T) {
	catalog := SpatialCatalog()
	if len(catalog) == 0 {
		t.Fatal("empty catalog")
	}
	first, ok := SpatialFind(catalog[0].Key)
	if !ok {
		t.Fatal("missing first definition")
	}
	original := first.Spaces[0]
	first.Spaces[0] = "changed"
	catalog[0].Rotations[0] = 999
	if first.WalkObstacle != nil {
		first.WalkObstacle.WidthCM = -1
	}
	again, ok := SpatialForThumbnail(catalog[0].ThumbnailAssetKey)
	if !ok || again.Spaces[0] != original || again.Rotations[0] == 999 || (again.WalkObstacle != nil && again.WalkObstacle.WidthCM < 0) {
		t.Fatalf("mutable definition escaped: %+v", again)
	}
	scene := SpatialSceneDefinition()
	originalX := scene.Regions[0].Polygon[0].XCM
	scene.Regions[0].Polygon[0].XCM += 100
	for key := range scene.ActivityPresentations {
		delete(scene.ActivityPresentations, key)
	}
	if fresh := SpatialSceneDefinition(); fresh.Regions[0].Polygon[0].XCM != originalX || len(fresh.ActivityPresentations) == 0 {
		t.Fatal("mutable scene escaped")
	}
}
