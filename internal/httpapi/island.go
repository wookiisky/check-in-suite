package httpapi

import "github.com/wookiisky/check-in-suite/internal/island"

// RegisterIsland keeps the centimeter layout and task qualifications as independent endpoints.
func (app *App) RegisterIsland(service *island.Service) {
	app.registerSpatialIsland(service)
	app.registerIslandActivityAccess(service)
}
