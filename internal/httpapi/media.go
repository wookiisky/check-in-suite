package httpapi

import (
	"context"
	"mime"
	"net/http"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/media"
)

// RegisterMedia exposes streaming upload, private reads and cancellation without exposing disk paths.
func (app *App) RegisterMedia(service *media.Service) {
	app.Mux.HandleFunc("POST /api/v1/media", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		if err := app.MutationGuard(r, p); err != nil {
			WriteError(w, r, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), service.Config.UploadTimeout)
		defer cancel()
		// File limits exclude multipart framing; the whole request allows only 64 KiB of framing.
		maximum := max(service.Config.Limits.PhotoBytesMax, service.Config.Limits.AudioBytesMax) + (64 << 10)
		if r.ContentLength > maximum {
			WriteError(w, r, core.Fail(413, "MEDIA_TOO_LARGE"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maximum)
		contentType, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "multipart/form-data" || parameters["boundary"] == "" {
			WriteError(w, r, core.Fail(400, "INVALID_REQUEST"))
			return
		}
		result, err := service.UploadMultipart(ctx, p, r.Body, parameters["boundary"])
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusCreated, result)
	})
	app.Mux.HandleFunc("GET /api/v1/media/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		info, file, err := service.Open(r.Context(), p, r.PathValue("id"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", info.MIMEType)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		modified, err := time.Parse(time.RFC3339Nano, info.CreatedAt)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		http.ServeContent(w, r, "media", modified, file)
	})
	app.Mux.HandleFunc("DELETE /api/v1/media/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		if err := app.MutationGuard(r, p); err != nil {
			WriteError(w, r, err)
			return
		}
		if err := service.Cancel(r.Context(), p, r.PathValue("id")); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, http.StatusNoContent, nil)
	})
}
