package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/assets"
)

// achievementHTTPFixture owns one real database, authenticated session and installed badge catalog.
type achievementHTTPFixture struct {
	t      *testing.T   // Current test owns failures and cleanup.
	app    *App         // Actual HTTP routes over the file-backed database.
	cookie *http.Cookie // Opaque authenticated session cookie.
	csrf   string       // Session-bound mutation token.
	badge  string       // An actual selectable badge from the installed catalog.
}

// newAchievementHTTPFixture adds achievement routes to the existing deterministic check-in fixture.
func newAchievementHTTPFixture(t *testing.T) achievementHTTPFixture {
	t.Helper()
	app, cookie, csrf := checkinApplication(t)
	service := achievement.New(app.DB, app.Accounts, app.Config)
	service.Now = app.Accounts.Now
	app.RegisterAchievements(service)
	art := assets.New(t.TempDir())
	if err := art.Install(); err != nil {
		t.Fatal(err)
	}
	app.RegisterAssets(art)
	items, err := art.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Kind == assets.Kind("badge") {
			return achievementHTTPFixture{t: t, app: app, cookie: cookie, csrf: csrf, badge: item.Key}
		}
	}
	t.Fatal("installed catalog has no achievement badges")
	return achievementHTTPFixture{}
}

// request serializes the exact protocol and preserves caller-supplied idempotency keys.
func (f achievementHTTPFixture) request(method, path string, body any, key string) *httptest.ResponseRecorder {
	f.t.Helper()
	encoded := ""
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		encoded = string(data)
	}
	return checkinRequest(f.app, method, "/api/v1"+path, encoded, f.cookie, f.csrf, key)
}

// success decodes a real JSON object after checking the operation's exact expected status.
func (f achievementHTTPFixture) success(response *httptest.ResponseRecorder, status int) map[string]any {
	f.t.Helper()
	if response.Code != status {
		f.t.Fatalf("HTTP status=%d want=%d body=%s", response.Code, status, response.Body)
	}
	if status == http.StatusNoContent {
		return nil
	}
	var object map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &object); err != nil {
		f.t.Fatalf("decode response: %v; %s", err, response.Body)
	}
	return object
}

// rule provides explicit nullable and collection values accepted by achievement creation.
func (f achievementHTTPFixture) rule(name, metric, scope string) map[string]any {
	return map[string]any{"name": name, "asset_key": f.badge, "metric": metric, "scope": scope, "category_id": nil, "task_ids": []string{}, "target": 1, "window_days": nil, "enabled": true}
}

// task creates a separate all-week task so each test controls its contributing facts.
func (f achievementHTTPFixture) task(categoryID any) map[string]any {
	return f.success(f.request("POST", "/management/tasks", map[string]any{"category_id": categoryID, "name": "成就验收任务", "icon_key": "book-v1", "coin_reward": 7, "diamond_reward": 3, "daily_limit": 3, "weekdays": []int{1, 2, 3, 4, 5, 6, 7}, "enabled": true}, "achievement-task"), 201)
}

// checkin creates one real record and original reward at the fixture's current business date.
func (f achievementHTTPFixture) checkin(taskID, key string) map[string]any {
	result := f.success(f.request("POST", "/checkins", map[string]any{"task_id": taskID, "expected_task_version": 1, "expected_today": "2026-10-29", "text": "", "photo_media_id": nil, "audio_media_id": nil}, key), 201)
	return result["checkin"].(map[string]any)
}

// item looks up a rule by identity instead of assuming list order or a single active rule.
func (f achievementHTTPFixture) item(id string) map[string]any {
	f.t.Helper()
	result := f.success(f.request("GET", "/achievements", nil, ""), 200)
	for _, value := range result["items"].([]any) {
		item := value.(map[string]any)
		if item["id"] == id {
			return item
		}
	}
	f.t.Fatalf("achievement %q missing from list: %+v", id, result)
	return nil
}
