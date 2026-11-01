package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// spatialPlacementRequest distinguishes an omitted coordinate from a valid integer zero.
type spatialPlacementRequest struct {
	InstanceID string              `json:"instance_id"` // 已购或免费实例身份。
	ItemKey    string              `json:"item_key"`    // 固定版本的物件定义。
	Space      island.SpatialSpace `json:"space"`       // 世界地面或室内局部坐标。
	XCM        *int                `json:"x_cm"`        // 必填横坐标，整数厘米。
	ZCM        *int                `json:"z_cm"`        // 必填纵深，整数厘米。
	Rotation   *int                `json:"rotation"`    // 必填四分之一圈朝向，允许零。
}

// registerSpatialIsland keeps the new centimeter contract independent from the legacy projected layout.
func (app *App) registerSpatialIsland(service *island.Service) {
	app.Mux.HandleFunc("GET /api/v1/island/scenes", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		items, err := service.ReadSpatialScenes(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, struct {
			Items []island.SpatialSceneOption `json:"items"` // 正式场景与当前家庭的永久资格。
		}{Items: items})
	})
	app.Mux.HandleFunc("GET /api/v1/island/layout", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		state, err := service.ReadSpatialScene(r.Context(), principal, r.URL.Query().Get("scene_key"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
	app.Mux.HandleFunc("PUT /api/v1/island/layout", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			ExpectedVersion int64                      `json:"expected_version"` // 用户核对的完整布局版本。
			SceneKey        string                     `json:"scene_key"`        // 整体场景身份。
			EnvironmentKey  string                     `json:"environment_key"`  // 环境叠加身份。
			Placements      []*spatialPlacementRequest `json:"placements"`       // 完整摆放草稿。
		} // 位置指针只用于检查HTTP字段存在性，不进入业务层。
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version", "scene_key", "environment_key", "placements"}); err != nil {
			WriteError(w, r, err)
			return
		}
		placements := make([]island.SpatialPlacement, 0, len(input.Placements))
		for _, item := range input.Placements {
			if item == nil || item.InstanceID == "" || item.ItemKey == "" || item.Space == "" || item.XCM == nil || item.ZCM == nil || item.Rotation == nil {
				WriteError(w, r, core.Invalid("placements", "REQUIRED"))
				return
			}
			placements = append(placements, island.SpatialPlacement{InstanceID: item.InstanceID, ItemKey: item.ItemKey, Space: item.Space, XCM: *item.XCM, ZCM: *item.ZCM, Rotation: *item.Rotation})
		}
		state, err := service.SaveSpatial(r.Context(), principal, island.SpatialSaveInput{ExpectedVersion: input.ExpectedVersion, SceneKey: input.SceneKey, EnvironmentKey: input.EnvironmentKey, Placements: placements})
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
}
