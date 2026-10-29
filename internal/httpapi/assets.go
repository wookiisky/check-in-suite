package httpapi

import (
	"net/http"

	"github.com/wookiisky/check-in-suite/internal/assets"
)

// RegisterAssets serves only installed controlled resources behind the current login session.
func (app *App) RegisterAssets(service *assets.Service) {
	app.Mux.HandleFunc("GET /api/v1/assets", func(w http.ResponseWriter, r *http.Request) {
		if _, err := app.Authenticate(r); err != nil {
			WriteError(w, r, err)
			return
		}
		items, err := service.List()
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusOK, struct {
			Items []assets.Asset `json:"items"`
		}{items})
	})
	app.Mux.HandleFunc("GET /api/v1/assets/{key}", func(w http.ResponseWriter, r *http.Request) {
		if _, err := app.Authenticate(r); err != nil {
			WriteError(w, r, err)
			return
		}
		item, err := service.Lookup(r.PathValue("key"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		still := r.URL.Query().Get("motion") == "static"
		file, err := service.OpenVariant(item.Key, still)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			WriteError(w, r, err)
			return
		}
		contentType := item.ContentType()
		if still && item.Kind == assets.KindEffect {
			contentType = "image/svg+xml"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
}
