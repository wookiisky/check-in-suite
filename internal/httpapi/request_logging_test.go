package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// TestHTTPLogsCorrelateCommittedEntitiesWithoutPrivateContent checks real requests and emitted JSON records.
func TestHTTPLogsCorrelateCommittedEntitiesWithoutPrivateContent(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	app, cookie, csrf := checkinApplication(t)
	configured := checkinRequest(app, "POST", "/api/v1/management/tasks", `{"category_id":null,"name":"读书","icon_key":"book-v1","coin_reward":1,"diamond_reward":0,"daily_limit":1,"weekdays":[1,2,3,4,5,6,7],"enabled":true}`, cookie, csrf, "log-task")
	if configured.Code != 201 {
		t.Fatalf("configure: %d %s", configured.Code, configured.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(configured.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	privateText := "家庭私密内容不要进入运行日志"
	querySecret := "query-secret-must-not-be-logged"
	input := fmt.Sprintf(`{"task_id":%q,"expected_task_version":1,"expected_today":"2026-10-29","text":%q,"photo_media_id":null,"audio_media_id":null}`, task.ID, privateText)
	created := checkinRequest(app, "POST", "/api/v1/checkins?private="+querySecret, input, cookie, csrf, "log-checkin")
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	var result checkin.CreateResult
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	deleted := checkinRequest(app, "DELETE", "/api/v1/checkins/"+result.Checkin.ID+"?private="+querySecret, `{"expected_version":1}`, cookie, csrf, "")
	if deleted.Code != 200 {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body)
	}
	denied := apiRequest(app, "GET", "/api/v1/session?private="+querySecret, "", nil, "")
	if denied.Code != 401 {
		t.Fatalf("unauthorized read: %d", denied.Code)
	}
	for _, secret := range []string{privateText, querySecret, cookie.Value, csrf, "login-password", "manage-password"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("private input found in logs: %q", secret)
		}
	}
	requests := map[string]struct {
		Status int    // Actual recorded HTTP response status.
		Route  string // Registered template without an entity or query string.
	}{
		created.Header().Get("X-Request-ID"): {201, "POST /api/v1/checkins"},
		deleted.Header().Get("X-Request-ID"): {200, "DELETE /api/v1/checkins/{id}"},
		denied.Header().Get("X-Request-ID"):  {401, "GET /api/v1/session"},
	}
	seenRequests, seenEntities := map[string]bool{}, map[string]bool{}
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var event map[string]any
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		id, _ := event["request_id"].(string)
		want, tracked := requests[id]
		if !tracked {
			continue
		}
		if event["checkin_id"] == result.Checkin.ID {
			seenEntities[id] = true
		}
		if status, ok := event["status"].(float64); ok {
			elapsed, hasDuration := event["duration_ms"].(float64)
			if int(status) != want.Status || event["route"] != want.Route || !hasDuration || elapsed < 0 {
				t.Fatalf("request diagnostic mismatch: %v", event)
			}
			seenRequests[id] = true
		}
	}
	for id := range requests {
		if id == "" || !seenRequests[id] {
			t.Fatalf("missing request diagnostic: %q", id)
		}
	}
	for _, id := range []string{created.Header().Get("X-Request-ID"), deleted.Header().Get("X-Request-ID")} {
		if !seenEntities[id] {
			t.Fatalf("committed entity is not correlated with request %q", id)
		}
	}
}

// TestCanceledTransactionLogSeverity separates expected cancellation from an unrelated server failure.
func TestCanceledTransactionLogSeverity(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest("POST", "/api/v1/checkins", nil).WithContext(ctx)
	for _, tc := range []struct {
		Failure error  // Database cancellation or unrelated infrastructure failure.
		Level   string // Cancellation is diagnostic; actual failures remain visible errors.
	}{{sql.ErrTxDone, "DEBUG"}, {errors.New("unrelated service failure"), "ERROR"}} {
		output.Reset()
		response := httptest.NewRecorder()
		response.Header().Set("X-Request-ID", "canceled-request")
		WriteError(response, request, tc.Failure)
		var event map[string]any
		if err := json.Unmarshal(output.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event["level"] != tc.Level || event["request_id"] != "canceled-request" || response.Code != 500 {
			t.Fatalf("unexpected failure diagnostic: %v response=%d", event, response.Code)
		}
	}
}
