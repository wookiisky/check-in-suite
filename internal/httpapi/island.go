package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// islandPlacementRequest distinguishes required coordinates from valid explicit zero values.
type islandPlacementRequest struct {
	ID       string   `json:"id"`       // Owned instance identity.
	ItemKey  string   `json:"item_key"` // Stable catalog identity.
	X        *float64 `json:"x"`        // Required horizontal ground coordinate.
	Y        *float64 `json:"y"`        // Required vertical ground coordinate.
	Rotation *int     `json:"rotation"` // Required orientation, including explicit zero.
	Zone     string   `json:"zone"`     // Indoor or outdoor placement area.
}

// RegisterIsland keeps layout writes available to the authenticated child without management authority.
func (app *App) RegisterIsland(service *island.Service) {
	app.Mux.HandleFunc("GET /api/v1/island", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		state, err := service.Read(r.Context(), principal)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
	app.Mux.HandleFunc("PUT /api/v1/island", func(w http.ResponseWriter, r *http.Request) {
		principal, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			ExpectedVersion int64                     `json:"expected_version"` // Reviewed island revision.
			Placements      []*islandPlacementRequest `json:"placements"`       // Complete desired layout.
		}
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version", "placements"}); err != nil {
			WriteError(w, r, err)
			return
		}
		placements := make([]island.Placement, 0, len(input.Placements))
		for _, item := range input.Placements {
			if item == nil || item.ID == "" || item.ItemKey == "" || item.X == nil || item.Y == nil || item.Rotation == nil || item.Zone == "" {
				WriteError(w, r, core.Invalid("placements", "REQUIRED"))
				return
			}
			placements = append(placements, island.Placement{ID: item.ID, ItemKey: item.ItemKey, X: *item.X, Y: *item.Y, Rotation: *item.Rotation, Zone: item.Zone})
		}
		state, err := service.Save(r.Context(), principal, island.SaveInput{ExpectedVersion: input.ExpectedVersion, Placements: placements})
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, state)
	})
}
