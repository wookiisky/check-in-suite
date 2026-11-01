package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// spatialHTTPState keeps the actual layout JSON for round trips through the centimeter endpoint.
type spatialHTTPState struct {
	Version        int64            `json:"version"`         // 新布局独立版本。
	SceneKey       string           `json:"scene_key"`       // 整体场景定义。
	EnvironmentKey string           `json:"environment_key"` // 环境叠加定义。
	Placements     []map[string]any `json:"placements"`      // 带显式整数坐标的完整布局。
	Inventory      []map[string]any `json:"inventory"`       // 完整实例库存。
	Catalog        []map[string]any `json:"catalog"`         // 已安装空间定义。
	Scene          json.RawMessage  `json:"scene"`           // 与布局采用同一坐标的场景数据。
}

// spatialHTTPBody serializes explicit zeros without converting a missing coordinate into a default.
func spatialHTTPBody(t *testing.T, body map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// TestSpatialLayoutHTTP verifies required nested coordinates, integer wire values and whole-layout conflicts.
func TestSpatialLayoutHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	app.RegisterIsland(island.New(app.DB, app.Accounts.Now))
	if response := apiRequest(app, http.MethodGet, "/api/v1/island/layout", "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous spatial read: %d %s", response.Code, response.Body)
	}
	initialResponse := request(http.MethodGet, "/api/v1/island/layout", "", "")
	var initial spatialHTTPState
	if initialResponse.Code != http.StatusOK || json.Unmarshal(initialResponse.Body.Bytes(), &initial) != nil || initial.Version != 1 || initial.SceneKey == "" || initial.EnvironmentKey == "" || len(initial.Placements) == 0 || len(initial.Inventory) == 0 || len(initial.Catalog) == 0 || len(initial.Scene) == 0 {
		t.Fatalf("initial spatial state: %d %s", initialResponse.Code, initialResponse.Body)
	}
	body := func() map[string]any {
		return map[string]any{"expected_version": initial.Version, "scene_key": initial.SceneKey, "environment_key": initial.EnvironmentKey, "placements": initial.Placements}
	}
	for _, field := range []string{"expected_version", "scene_key", "environment_key", "placements"} {
		invalid := body()
		delete(invalid, field)
		response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, invalid), "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "REQUIRED") {
			t.Fatalf("missing root field %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, field := range []string{"instance_id", "item_key", "space", "x_cm", "z_cm", "rotation"} {
		first := make(map[string]any, len(initial.Placements[0]))
		for key, value := range initial.Placements[0] {
			first[key] = value
		}
		delete(first, field)
		invalid := body()
		invalid["placements"] = []map[string]any{first}
		response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, invalid), "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "REQUIRED") {
			t.Fatalf("missing placement field %s accepted: %d %s", field, response.Code, response.Body)
		}
	}
	for _, field := range []string{"x_cm", "z_cm", "rotation"} {
		for _, value := range []any{nil, 0.5, "0"} {
			first := make(map[string]any, len(initial.Placements[0]))
			for key, current := range initial.Placements[0] {
				first[key] = current
			}
			first[field] = value
			invalid := body()
			invalid["placements"] = []map[string]any{first}
			if response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest {
				t.Fatalf("non-integer %s=%v accepted: %d %s", field, value, response.Code, response.Body)
			}
		}
	}
	for _, placements := range []any{nil, []any{nil}} {
		invalid := body()
		invalid["placements"] = placements
		if response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest {
			t.Fatalf("null layout element accepted: %d %s", response.Code, response.Body)
		}
	}
	for _, coordinate := range []int64{9_007_199_254_740_992, -9_007_199_254_740_992} {
		first := make(map[string]any, len(initial.Placements[0]))
		for key, current := range initial.Placements[0] {
			first[key] = current
		}
		first["x_cm"] = coordinate
		invalid := body()
		invalid["placements"] = []map[string]any{first}
		if response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, invalid), ""); response.Code != http.StatusBadRequest {
			t.Fatalf("unsafe JSON integer accepted: %d => %d %s", coordinate, response.Code, response.Body)
		}
	}
	valid := spatialHTTPBody(t, body())
	if response := apiRequest(app, http.MethodPut, "/api/v1/island/layout", valid, nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous spatial save: %d %s", response.Code, response.Body)
	}
	login := apiRequest(app, http.MethodPost, "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != http.StatusOK {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	if response := apiRequest(app, http.MethodPut, "/api/v1/island/layout", valid, login.Result().Cookies()[0], ""); response.Code != http.StatusForbidden {
		t.Fatalf("spatial save without csrf: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodPost, "/api/v1/management/lock", "", ""); response.Code != http.StatusNoContent {
		t.Fatalf("lock management: %d %s", response.Code, response.Body)
	}
	response := request(http.MethodPut, "/api/v1/island/layout", valid, "")
	var saved spatialHTTPState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Version != initial.Version+1 {
		t.Fatalf("save initial integer layout without management: %d %s", response.Code, response.Body)
	}
	if response := request(http.MethodPut, "/api/v1/island/layout", valid, ""); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "VERSION_CONFLICT") {
		t.Fatalf("stale spatial save accepted: %d %s", response.Code, response.Body)
	}
	unowned := body()
	unowned["expected_version"] = saved.Version
	unowned["placements"] = append(append([]map[string]any{}, initial.Placements...), map[string]any{"instance_id": "not-owned", "item_key": initial.Placements[0]["item_key"], "space": "outdoor", "x_cm": 0, "z_cm": 0, "rotation": 0})
	if response := request(http.MethodPut, "/api/v1/island/layout", spatialHTTPBody(t, unowned), ""); response.Code != http.StatusBadRequest {
		t.Fatalf("unowned placement accepted: %d %s", response.Code, response.Body)
	}
	response = request(http.MethodGet, "/api/v1/island/layout", "", "")
	var unchanged spatialHTTPState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &unchanged) != nil || unchanged.Version != saved.Version || len(unchanged.Placements) != len(saved.Placements) {
		t.Fatalf("invalid layout changed persisted state: %d %s", response.Code, response.Body)
	}
}
