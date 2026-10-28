package httpapi

import (
	"net/http"
	"strconv"

	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// versionRequest permits only optimistic confirmation when deleting mutable resources.
type versionRequest struct {
	ExpectedVersion int64 `json:"expected_version"` // Last displayed entity version.
}

// taskCreation excludes edit-only version fields from the create route's accepted JSON.
type taskCreation struct {
	CategoryID    *string `json:"category_id"`    // Optional category.
	Name          string  `json:"name"`           // Required display name.
	IconKey       string  `json:"icon_key"`       // Controlled versioned icon.
	CoinReward    int64   `json:"coin_reward"`    // Nonnegative coin reward.
	DiamondReward int64   `json:"diamond_reward"` // Nonnegative diamond reward.
	DailyLimit    int64   `json:"daily_limit"`    // Positive daily allowance.
	Weekdays      []int   `json:"weekdays"`       // Monday-based eligible weekdays.
	Enabled       bool    `json:"enabled"`        // Initial future-record eligibility.
}

// RegisterCheckins binds ordinary and management authority to distinct server routes.
func (app *App) RegisterCheckins(service *checkin.Service) {
	app.Mux.HandleFunc("GET /api/v1/camp", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Camp(r.Context(), p, r.URL.Query().Get("category_id"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("GET /api/v1/categories", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Categories(r.Context(), p)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, struct {
			Items []checkin.Category `json:"items"`
		}{result})
	})
	app.Mux.HandleFunc("GET /api/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		inactive := false
		if value := r.URL.Query().Get("include_inactive"); value != "" {
			inactive, err = strconv.ParseBool(value)
			if err != nil {
				WriteError(w, r, core.Invalid("include_inactive", "INVALID_BOOLEAN"))
				return
			}
		}
		result, err := service.Tasks(r.Context(), p, inactive)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, struct {
			Items []checkin.Task `json:"items"`
		}{result})
	})
	app.Mux.HandleFunc("GET /api/v1/checkins", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.Authenticate(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		q := r.URL.Query()
		limit := 50
		if raw := q.Get("limit"); raw != "" {
			limit, err = strconv.Atoi(raw)
			if err != nil {
				WriteError(w, r, core.Invalid("limit", "INVALID_NUMBER"))
				return
			}
		}
		result, err := service.List(r.Context(), p, q.Get("start_date"), q.Get("end_date"), q.Get("cursor"), limit)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.registerTaskConfiguration(service)
	for _, route := range []struct {
		Prefix     string
		Management bool
	}{{"/api/v1/checkins", false}, {"/api/v1/management/checkins", true}} {
		app.Mux.HandleFunc("POST "+route.Prefix, app.createCheckin(service, route.Management))
		app.Mux.HandleFunc("PATCH "+route.Prefix+"/{id}", app.editCheckin(service, route.Management))
		app.Mux.HandleFunc("DELETE "+route.Prefix+"/{id}", app.deleteCheckin(service, route.Management))
	}
}

// registerTaskConfiguration adapts configuration input without deriving authority from the body.
func (app *App) registerTaskConfiguration(service *checkin.Service) {
	app.Mux.HandleFunc("POST /api/v1/management/categories", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input struct {
			Name      string `json:"name"`
			SortOrder int64  `json:"sort_order"`
		}
		if err := decodeRequiredJSON(w, r, &input, []string{"name"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.CreateCategory(r.Context(), p, r.Header.Get("Idempotency-Key"), checkin.CategoryInput{Name: input.Name, SortOrder: input.SortOrder})
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 201, result)
	})
	app.Mux.HandleFunc("PATCH /api/v1/management/categories/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input checkin.CategoryInput
		if err := decodeRequiredJSON(w, r, &input, []string{"name", "expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.UpdateCategory(r.Context(), p, r.PathValue("id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("DELETE /api/v1/management/categories/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input versionRequest
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		if err := service.DeleteCategory(r.Context(), p, r.PathValue("id"), input.ExpectedVersion); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 204, nil)
	})
	app.Mux.HandleFunc("POST /api/v1/management/tasks", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input taskCreation
		if err := decodeRequiredJSON(w, r, &input, []string{"category_id", "name", "icon_key", "coin_reward", "diamond_reward", "daily_limit", "weekdays", "enabled"}, "category_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.CreateTask(r.Context(), p, r.Header.Get("Idempotency-Key"), checkin.TaskInput{CategoryID: input.CategoryID, Name: input.Name, IconKey: input.IconKey, CoinReward: input.CoinReward, DiamondReward: input.DiamondReward, DailyLimit: input.DailyLimit, Weekdays: input.Weekdays, Enabled: input.Enabled})
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 201, result)
	})
	app.Mux.HandleFunc("PATCH /api/v1/management/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input checkin.TaskInput
		if err := decodeRequiredJSON(w, r, &input, []string{"category_id", "name", "icon_key", "coin_reward", "diamond_reward", "daily_limit", "weekdays", "enabled", "expected_version"}, "category_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.UpdateTask(r.Context(), p, r.PathValue("id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	})
	app.Mux.HandleFunc("DELETE /api/v1/management/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input versionRequest
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		if err := service.DeleteTask(r.Context(), p, r.PathValue("id"), input.ExpectedVersion); err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 204, nil)
	})
}

// createCheckin gives ordinary and management routes different accepted date fields.
func (app *App) createCheckin(service *checkin.Service, management bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input checkin.CreateInput
		if management {
			var body struct {
				TaskID              string  `json:"task_id"`
				BusinessDate        string  `json:"business_date"`
				ExpectedTaskVersion int64   `json:"expected_task_version"`
				Text                string  `json:"text"`
				PhotoMediaID        *string `json:"photo_media_id"`
				AudioMediaID        *string `json:"audio_media_id"`
			}
			if err := decodeRequiredJSON(w, r, &body, []string{"task_id", "expected_task_version", "business_date"}, "photo_media_id", "audio_media_id"); err != nil {
				WriteError(w, r, err)
				return
			}
			input = checkin.CreateInput{TaskID: body.TaskID, BusinessDate: body.BusinessDate, ExpectedTaskVersion: body.ExpectedTaskVersion, Text: body.Text, PhotoMediaID: body.PhotoMediaID, AudioMediaID: body.AudioMediaID}
		} else {
			var body struct {
				TaskID              string  `json:"task_id"`
				ExpectedToday       string  `json:"expected_today"`
				ExpectedTaskVersion int64   `json:"expected_task_version"`
				Text                string  `json:"text"`
				PhotoMediaID        *string `json:"photo_media_id"`
				AudioMediaID        *string `json:"audio_media_id"`
			}
			if err := decodeRequiredJSON(w, r, &body, []string{"task_id", "expected_task_version", "expected_today"}, "photo_media_id", "audio_media_id"); err != nil {
				WriteError(w, r, err)
				return
			}
			input = checkin.CreateInput{TaskID: body.TaskID, ExpectedToday: body.ExpectedToday, ExpectedTaskVersion: body.ExpectedTaskVersion, Text: body.Text, PhotoMediaID: body.PhotoMediaID, AudioMediaID: body.AudioMediaID}
		}
		result, err := service.Create(r.Context(), p, management, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 201, result)
	}
}

// editCheckin never accepts date, task or reward changes.
func (app *App) editCheckin(service *checkin.Service, management bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input checkin.EditInput
		if err := decodeRequiredJSON(w, r, &input, []string{"text", "photo_media_id", "audio_media_id", "expected_version"}, "photo_media_id", "audio_media_id"); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Edit(r.Context(), p, management, r.PathValue("id"), input)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	}
}

// deleteCheckin returns a repeatable deletion state and does not invent a second revocation.
func (app *App) deleteCheckin(service *checkin.Service, management bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := app.authenticatedWrite(r)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		var input versionRequest
		if err := decodeRequiredJSON(w, r, &input, []string{"expected_version"}); err != nil {
			WriteError(w, r, err)
			return
		}
		result, err := service.Delete(r.Context(), p, management, r.PathValue("id"), input.ExpectedVersion)
		if err != nil {
			WriteError(w, r, err)
			return
		}
		WriteJSON(w, 200, result)
	}
}
