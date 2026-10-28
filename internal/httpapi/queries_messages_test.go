package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/message"
)

// TestReportsHTTP exercises serialized dates, counts and private empty-state responses.
func TestReportsHTTP(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	reports := checkin.New(app.DB, app.Accounts, app.Config)
	reports.Now = app.Accounts.Now
	app.RegisterQueries(reports)
	for _, path := range []string{"/api/v1/calendar?month=2026-10", "/api/v1/stats?start_date=2026-10-01&end_date=2026-10-29"} {
		response := apiRequest(app, "GET", path, "", nil, "")
		if response.Code != 401 {
			t.Fatalf("public report exposed: %d", response.Code)
		}
	}
	configured := checkinRequest(app, "POST", "/api/v1/management/tasks", `{"category_id":null,"name":"读书","icon_key":"book-v1","coin_reward":0,"diamond_reward":0,"daily_limit":2,"weekdays":[1,2,3,4,5,6,7],"enabled":true}`, cookie, csrf, "report-task")
	if configured.Code != 201 {
		t.Fatalf("task: %d %s", configured.Code, configured.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(configured.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	created := checkinRequest(app, "POST", "/api/v1/checkins", fmt.Sprintf(`{"task_id":%q,"expected_task_version":1,"expected_today":"2026-10-29","text":""}`, task.ID), cookie, csrf, "report-record")
	if created.Code != 201 {
		t.Fatalf("record: %d %s", created.Code, created.Body)
	}
	response := apiRequest(app, "GET", "/api/v1/stats?start_date=2026-10-01&end_date=2026-10-29", "", cookie, "")
	if response.Code != 200 {
		t.Fatalf("stats: %d %s", response.Code, response.Body)
	}
	var stats map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats["total_count"] != float64(1) || stats["active_days"] != float64(1) || stats["start_date"] != "2026-10-01" {
		t.Fatalf("statistics protocol: %v", stats)
	}
	response = apiRequest(app, "GET", "/api/v1/calendar?month=2026-10", "", cookie, "")
	var calendar checkin.CalendarResult
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &calendar) != nil || len(calendar.Days) != 31 || calendar.Days[28].Count != 1 {
		t.Fatalf("calendar: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/stats?start_date=2026-10-01&end_date=2026-10-30", "", cookie, "")
	if response.Code != 422 {
		t.Fatalf("future statistics: %d", response.Code)
	}
}

// TestMessagesHTTP verifies CSRF, strict inputs, successful replay and nullable pagination over HTTP.
func TestMessagesHTTP(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	service := message.New(app.DB, app.Config)
	service.Now = app.Accounts.Now
	app.RegisterMessages(service)
	response := apiRequest(app, "GET", "/api/v1/messages", "", nil, "")
	if response.Code != 401 {
		t.Fatalf("public notes exposed: %d", response.Code)
	}
	response = checkinRequest(app, "POST", "/api/v1/messages", `{"text":"一条留言"}`, cookie, "", "message-command")
	if response.Code != 403 {
		t.Fatalf("missing CSRF: %d", response.Code)
	}
	response = checkinRequest(app, "POST", "/api/v1/messages", `{"text":"一条留言","id":"client-id"}`, cookie, csrf, "message-command")
	if response.Code != 400 {
		t.Fatalf("unknown field accepted: %d", response.Code)
	}
	var first message.Message
	for range 2 {
		response = checkinRequest(app, "POST", "/api/v1/messages", `{"text":"一条留言"}`, cookie, csrf, "message-command")
		if response.Code != 201 {
			t.Fatalf("message create: %d %s", response.Code, response.Body)
		}
		var current message.Message
		if err := json.Unmarshal(response.Body.Bytes(), &current); err != nil {
			t.Fatal(err)
		}
		if first.ID != "" && first.ID != current.ID {
			t.Fatal("HTTP replay duplicated a note")
		}
		first = current
	}
	response = apiRequest(app, "GET", "/api/v1/messages?limit=1", "", cookie, "")
	var page map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || page["next_cursor"] != nil {
		t.Fatalf("complete page protocol: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "DELETE", "/api/v1/messages/"+first.ID, "", cookie, csrf)
	if response.Code != 204 {
		t.Fatalf("delete: %d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/messages", "", cookie, "")
	var empty message.Page
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &empty) != nil || empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty page: %d %s", response.Code, response.Body)
	}
}
