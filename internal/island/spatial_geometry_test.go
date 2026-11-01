package island

import (
	"encoding/json"
	"os"
	"testing"
)

// spatialGeometryFixture 与 TypeScript 读取同一份实际厘米坐标样例。
type spatialGeometryFixture struct {
	Regions map[string][]SpatialTerrainRegion `json:"regions"` // 命名地形样例。
	Cases   []struct {
		Name     string   `json:"name"`     // 边界含义。
		Regions  string   `json:"regions"`  // 地形样例身份。
		XCM      int      `json:"x_cm"`     // 待检查中心。
		ZCM      int      `json:"z_cm"`     // 待检查纵深。
		Rotation int      `json:"rotation"` // 四分之一圈。
		WidthCM  int      `json:"width_cm"` // 未旋转宽度。
		DepthCM  int      `json:"depth_cm"` // 未旋转纵深。
		Allowed  []string `json:"allowed"`  // 允许的地形。
		Valid    bool     `json:"valid"`    // 完整占地是否放行。
	} `json:"cases"`
}

// TestSpatialGeometryCases 不让中心、四角或重复面积代替完整覆盖判断。
func TestSpatialGeometryCases(t *testing.T) {
	data, err := os.ReadFile("testdata/spatial-geometry-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture spatialGeometryFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			placement := SpatialPlacement{XCM: tc.XCM, ZCM: tc.ZCM, Rotation: tc.Rotation}
			footprint := SpatialFootprint{WidthCM: tc.WidthCM, DepthCM: tc.DepthCM}
			if got := SpatialFootprintCovered(placement, footprint, fixture.Regions[tc.Regions], tc.Allowed); got != tc.Valid {
				t.Fatalf("got %v, want %v", got, tc.Valid)
			}
		})
	}
}

// TestSpatialGeometryInvalid 拒绝空或非法占地与无效旋转。
func TestSpatialGeometryInvalid(t *testing.T) {
	regions := SpatialSceneDefinition().Regions
	for _, tc := range []struct {
		placement SpatialPlacement
		footprint SpatialFootprint
	}{
		{SpatialPlacement{}, SpatialFootprint{}},
		{SpatialPlacement{}, SpatialFootprint{WidthCM: -1, DepthCM: 100}},
		{SpatialPlacement{Rotation: 4}, SpatialFootprint{WidthCM: 100, DepthCM: 100}},
	} {
		if SpatialFootprintCovered(tc.placement, tc.footprint, regions, []string{"grass"}) {
			t.Fatal("invalid footprint was admitted")
		}
	}
}
