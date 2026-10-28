package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// TestCheckinRequiredContentPreservesDatabase rejects absent fields before replacing any content.
func TestCheckinRequiredContentPreservesDatabase(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	createdTask := checkinRequest(app, "POST", "/api/v1/management/tasks", `{"category_id":null,"name":"读书","icon_key":"book-v1","coin_reward":10,"diamond_reward":2,"daily_limit":2,"weekdays":[1,2,3,4,5,6,7],"enabled":true}`, cookie, csrf, "required-task")
	if createdTask.Code != 201 {
		t.Fatalf("task: %d %s", createdTask.Code, createdTask.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(createdTask.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	created := checkinRequest(app, "POST", "/api/v1/checkins", fmt.Sprintf(`{"task_id":%q,"expected_task_version":1,"expected_today":"2026-10-29","text":"原内容"}`, task.ID), cookie, csrf, "required-record")
	if created.Code != 201 {
		t.Fatalf("record: %d %s", created.Code, created.Body)
	}
	var record checkin.CreateResult
	if err := json.Unmarshal(created.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"expected_version":1}`,
		`{"expected_version":1,"text":"替换","audio_media_id":null}`,
		`{"expected_version":1,"text":"替换","photo_media_id":null}`,
		`{"text":"替换","photo_media_id":null,"audio_media_id":null}`,
		`{"expected_version":1,"text":null,"photo_media_id":null,"audio_media_id":null}`,
		`{"expected_version":null,"text":"替换","photo_media_id":null,"audio_media_id":null}`,
	} {
		response := checkinRequest(app, "PATCH", "/api/v1/checkins/"+record.Checkin.ID, body, cookie, csrf, "")
		if response.Code != 400 {
			t.Errorf("invalid patch accepted: %s status=%d body=%s", body, response.Code, response.Body)
		}
		var text string
		var version int64
		if err := app.DB.QueryRow("SELECT text,version FROM checkins WHERE id=?", record.Checkin.ID).Scan(&text, &version); err != nil {
			t.Fatal(err)
		}
		if text != "原内容" || version != 1 {
			t.Errorf("invalid patch changed database: text=%q version=%d", text, version)
		}
	}
}

// TestTaskRequiredNumbersAndBoolean distinguishes missing or null fields from legitimate zero and false.
func TestTaskRequiredNumbersAndBoolean(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	valid := map[string]any{"category_id": nil, "name": "配置", "icon_key": "book-v1", "coin_reward": 10, "diamond_reward": 2, "daily_limit": 1, "weekdays": []int{1, 2, 3, 4, 5, 6, 7}, "enabled": true}
	raw, _ := json.Marshal(valid)
	created := checkinRequest(app, "POST", "/api/v1/management/tasks", string(raw), cookie, csrf, "configured")
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(created.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"coin_reward", "diamond_reward", "enabled"} {
		for _, asNull := range []bool{false, true} {
			input := make(map[string]any, len(valid))
			for key, value := range valid {
				input[key] = value
			}
			if asNull {
				input[field] = nil
			} else {
				delete(input, field)
			}
			body, _ := json.Marshal(input)
			response := checkinRequest(app, "POST", "/api/v1/management/tasks", string(body), cookie, csrf, fmt.Sprintf("missing-%s-%t", field, asNull))
			if response.Code != 400 {
				t.Errorf("create %s null=%t: %d %s", field, asNull, response.Code, response.Body)
			}
			input["expected_version"] = 1
			body, _ = json.Marshal(input)
			response = checkinRequest(app, "PATCH", "/api/v1/management/tasks/"+task.ID, string(body), cookie, csrf, "")
			if response.Code != 400 {
				t.Errorf("patch %s null=%t: %d %s", field, asNull, response.Code, response.Body)
			}
			var coins, diamonds, version int64
			var enabled bool
			if err := app.DB.QueryRow("SELECT coin_reward,diamond_reward,enabled,version FROM tasks WHERE id=?", task.ID).Scan(&coins, &diamonds, &enabled, &version); err != nil {
				t.Fatal(err)
			}
			if coins != 10 || diamonds != 2 || !enabled || version != 1 {
				t.Errorf("invalid task changed database: coins=%d diamonds=%d enabled=%t version=%d", coins, diamonds, enabled, version)
			}
		}
	}
	var count int
	if err := app.DB.QueryRow("SELECT count(*) FROM tasks").Scan(&count); err != nil || count != 1 {
		t.Errorf("invalid creates persisted: count=%d error=%v", count, err)
	}
	valid["coin_reward"] = 0
	valid["diamond_reward"] = 0
	valid["enabled"] = false
	raw, _ = json.Marshal(valid)
	zero := checkinRequest(app, "POST", "/api/v1/management/tasks", string(raw), cookie, csrf, "explicit-zero")
	if zero.Code != 201 {
		t.Fatalf("valid zero/false rejected: %d %s", zero.Code, zero.Body)
	}
}
