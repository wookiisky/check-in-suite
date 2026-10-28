package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// checkinRequest supplies the exact browser protocol, including CSRF and an optional command key.
func checkinRequest(app *App, method, path, body string, cookie *http.Cookie, csrf, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", app.Config.PublicOrigin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", csrf)
	request.Header.Set("Idempotency-Key", key)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	return response
}

// checkinApplication creates one real account and route registry with a deterministic Taipei date.
func checkinApplication(t *testing.T) (*App, *http.Cookie, string) {
	t.Helper()
	app := accountApplication(t)
	clock := func() time.Time { return time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC) }
	app.Accounts.Now = clock
	service := checkin.New(app.DB, app.Accounts, app.Config)
	service.Now = clock
	app.RegisterCheckins(service)
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login %d %s", login.Code, login.Body)
	}
	var session struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	unlock := apiRequest(app, "POST", "/api/v1/management/unlock", `{"password":"manage-password"}`, cookie, session.CSRF)
	if unlock.Code != 200 {
		t.Fatalf("unlock %d %s", unlock.Code, unlock.Body)
	}
	return app, cookie, session.CSRF
}

// TestCheckinHTTP uses serialized input to prove route authority and one reward after response loss.
func TestCheckinHTTP(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	configured := checkinRequest(app, "POST", "/api/v1/management/tasks", `{"category_id":null,"name":"读书","icon_key":"book-v1","coin_reward":10,"diamond_reward":2,"daily_limit":2,"weekdays":[1,2,3,4,5,6,7],"enabled":true}`, cookie, csrf, "task")
	if configured.Code != 201 {
		t.Fatalf("task %d %s", configured.Code, configured.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(configured.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	input := fmt.Sprintf(`{"task_id":%q,"expected_task_version":1,"expected_today":"2026-10-29","text":"实际HTTP打卡","photo_media_id":null,"audio_media_id":null}`, task.ID)
	for _, suffix := range []string{`,"business_date":null}`, `,"coin_reward":999}`, `,"is_admin":true}`} {
		body := strings.TrimSuffix(input, "}") + suffix
		bad := checkinRequest(app, "POST", "/api/v1/checkins", body, cookie, csrf, "bad")
		if bad.Code != 400 {
			t.Fatalf("unknown field %d %s", bad.Code, bad.Body)
		}
	}
	request := httptest.NewRequest("POST", "/api/v1/checkins", strings.NewReader(input))
	request.Header.Set("Origin", app.Config.PublicOrigin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", csrf)
	request.Header.Set("Idempotency-Key", "lost-response")
	request.AddCookie(cookie)
	dropped := &discardedResponse{header: make(http.Header)}
	app.ServeHTTP(dropped, request)
	if dropped.status != 201 {
		t.Fatalf("original status=%d", dropped.status)
	}
	replayed := checkinRequest(app, "POST", "/api/v1/checkins", input, cookie, csrf, "lost-response")
	if replayed.Code != 201 {
		t.Fatalf("replay %d %s", replayed.Code, replayed.Body)
	}
	var created checkin.CreateResult
	if err := json.Unmarshal(replayed.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Wallet.Coins != 10 || created.TaskRemaining != 1 || created.Checkin.Deleted || !created.Checkin.CanEdit {
		t.Fatalf("%+v", created)
	}
	var count int
	if err := app.DB.QueryRow("SELECT count(*) FROM checkins").Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate record: %d %v", count, err)
	}
	invalid := checkinRequest(app, "PATCH", "/api/v1/checkins/"+created.Checkin.ID, `{"expected_version":1,"text":"编辑","business_date":"2026-10-28"}`, cookie, csrf, "")
	if invalid.Code != 400 {
		t.Fatalf("date mutation allowed %d", invalid.Code)
	}
	for i := 0; i < 2; i++ {
		deleted := checkinRequest(app, "DELETE", "/api/v1/checkins/"+created.Checkin.ID, `{"expected_version":1}`, cookie, csrf, "")
		if deleted.Code != 200 {
			t.Fatalf("delete %d %s", deleted.Code, deleted.Body)
		}
	}
	var entries int
	if err := app.DB.QueryRow("SELECT count(*) FROM wallet_entries").Scan(&entries); err != nil || entries != 2 {
		t.Fatalf("events=%d %v", entries, err)
	}
	lock := apiRequest(app, "POST", "/api/v1/management/lock", "", cookie, csrf)
	if lock.Code != 204 {
		t.Fatal(lock.Body)
	}
	inactive := checkinRequest(app, "GET", "/api/v1/tasks?include_inactive=true", "", cookie, "", "")
	if inactive.Code != 403 {
		t.Fatalf("locked inactive read=%d", inactive.Code)
	}
}

// discardedResponse simulates a connection failing only when the committed response is written.
type discardedResponse struct {
	header http.Header
	status int
}

// Header retains protocol headers even when the transport later fails.
func (w *discardedResponse) Header() http.Header { return w.header }

// WriteHeader records the attempted status after the service transaction has completed.
func (w *discardedResponse) WriteHeader(status int) { w.status = status }

// Write rejects every response byte, preserving the unknown-result failure boundary.
func (w *discardedResponse) Write([]byte) (int, error) {
	return 0, errors.New("connection closed after commit")
}

// TestCheckinHTTPValidation rejects fractional integers and unauthorized history writes.
func TestCheckinHTTPValidation(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	fractional := checkinRequest(app, "POST", "/api/v1/management/tasks", `{"name":"读书","icon_key":"book-v1","coin_reward":0.5,"diamond_reward":0,"daily_limit":1,"weekdays":[4],"enabled":true}`, cookie, csrf, "fractional")
	if fractional.Code != 400 {
		t.Fatalf("fraction accepted: %d", fractional.Code)
	}
	missingKey := checkinRequest(app, "POST", "/api/v1/management/categories", `{"name":"学习"}`, cookie, csrf, "")
	if missingKey.Code != 400 {
		t.Fatalf("missing idempotency key: %d", missingKey.Code)
	}
	badRange := checkinRequest(app, "GET", "/api/v1/checkins?start_date=2026-10-30&end_date=2026-10-01", "", cookie, "", "")
	if badRange.Code != 422 {
		t.Fatalf("range: %d", badRange.Code)
	}
	principal, err := app.Accounts.Authenticate(context.Background(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Accounts.Logout(context.Background(), principal); err != nil {
		t.Fatal(err)
	}
	stale := checkinRequest(app, "GET", "/api/v1/camp", "", cookie, "", "")
	if stale.Code != 401 {
		t.Fatalf("stale session: %d", stale.Code)
	}
}

// TestCheckinHTTPBusy uses a second SQLite connection holding a real IMMEDIATE lock.
func TestCheckinHTTPBusy(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	ctx := context.Background()
	var sequence int
	var name, path string
	if err := app.DB.QueryRow("PRAGMA database_list").Scan(&sequence, &name, &path); err != nil {
		t.Fatal(err)
	}
	locker, err := storage.Open(ctx, path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close()
	if _, err := app.DB.Exec("PRAGMA busy_timeout=30"); err != nil {
		t.Fatal(err)
	}
	locked, err := locker.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback()
	response := checkinRequest(app, "POST", "/api/v1/management/categories", `{"name":"等待写锁"}`, cookie, csrf, "busy-command")
	if response.Code != 503 || !strings.Contains(response.Body.String(), `"code":"DATABASE_BUSY"`) {
		t.Fatalf("busy: %d %s", response.Code, response.Body)
	}
	if err := locked.Rollback(); err != nil {
		t.Fatal(err)
	}
	response = checkinRequest(app, "POST", "/api/v1/management/categories", `{"name":"等待写锁"}`, cookie, csrf, "busy-command")
	if response.Code != 201 {
		t.Fatalf("retry after release: %d %s", response.Code, response.Body)
	}
	var count int
	if err := app.DB.QueryRow("SELECT count(*) FROM categories").Scan(&count); err != nil || count != 1 {
		t.Fatalf("partial category: %d %v", count, err)
	}
}
