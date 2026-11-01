package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestSpatialSceneHTTP 核对场景目录鉴权、默认场景兼容和未拥有空间的读取边界。
func TestSpatialSceneHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	app.RegisterIsland(island.New(app.DB, app.Accounts.Now))
	if response := apiRequest(app, http.MethodGet, "/api/v1/island/scenes", "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous scenes: %d %s", response.Code, response.Body)
	}
	response := request(http.MethodGet, "/api/v1/island/scenes", "", "")
	var catalog struct {
		Items []island.SpatialSceneOption `json:"items"` // 当前受控场景及家庭资格。
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog.Items) != 3 {
		t.Fatalf("scenes: %d %s", response.Code, response.Body)
	}
	for _, item := range catalog.Items {
		if item.Key == "seaside-v1" && (!item.Free || !item.Owned) {
			t.Fatalf("default scene lost free access: %+v", item)
		}
		if item.Key != "seaside-v1" && (item.Free || item.Owned) {
			t.Fatalf("new scene granted without purchase: %+v", item)
		}
	}
	for _, path := range []string{"/api/v1/island/layout", "/api/v1/island/layout?scene_key=seaside-v1"} {
		response = request(http.MethodGet, path, "", "")
		var state island.SpatialState
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.SceneKey != "seaside-v1" || state.Scene.House == nil {
			t.Fatalf("default layout %s: %d %s", path, response.Code, response.Body)
		}
	}
	for _, key := range []string{"unknown-scene", "forest-courtyard-v1", "lakeside-garden-v1"} {
		if response = request(http.MethodGet, "/api/v1/island/layout?scene_key="+key, "", ""); response.Code != http.StatusBadRequest {
			t.Fatalf("unavailable scene %s: %d %s", key, response.Code, response.Body)
		}
	}
}
