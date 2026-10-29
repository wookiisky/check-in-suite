package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// TestTaskIslandActivitiesHTTP verifies the actual JSON boundary, omitted updates and explicit clearing.
func TestTaskIslandActivitiesHTTP(t *testing.T) {
	app, cookie, csrf := checkinApplication(t)
	base := `"category_id":null,"name":"读书","icon_key":"book-v1","coin_reward":10,"diamond_reward":2,"daily_limit":2,"weekdays":[1,2,3,4,5,6,7],"enabled":true`
	for _, value := range []string{`null`, `["swim"]`, `"read"`} {
		response := checkinRequest(app, "POST", "/api/v1/management/tasks", `{`+base+`,"unlock_activities":`+value+`}`, cookie, csrf, "invalid-activity")
		if response.Code != 400 {
			t.Fatalf("invalid %s status=%d body=%s", value, response.Code, response.Body)
		}
	}
	response := checkinRequest(app, "POST", "/api/v1/management/tasks", `{`+base+`,"unlock_activities":["read","ball"]}`, cookie, csrf, "task-with-activities")
	if response.Code != 201 {
		t.Fatalf("create %d %s", response.Code, response.Body)
	}
	var task checkin.Task
	if err := json.Unmarshal(response.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if len(task.UnlockActivities) != 2 || task.UnlockActivities[0] != "ball" {
		t.Fatalf("task=%+v", task)
	}
	path := "/api/v1/management/tasks/" + task.ID
	response = checkinRequest(app, "PATCH", path, fmt.Sprintf(`{%s,"expected_version":1}`, base), cookie, csrf, "")
	if response.Code != 200 {
		t.Fatalf("omitted %d %s", response.Code, response.Body)
	}
	if err := json.Unmarshal(response.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if len(task.UnlockActivities) != 2 {
		t.Fatalf("omitted update erased links: %s", response.Body)
	}
	response = checkinRequest(app, "PATCH", path, fmt.Sprintf(`{%s,"expected_version":2,"unlock_activities":[]}`, base), cookie, csrf, "")
	if response.Code != 200 {
		t.Fatalf("clear %d %s", response.Code, response.Body)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if string(body["unlock_activities"]) != "[]" {
		t.Fatalf("cleared array=%s", body["unlock_activities"])
	}
	response = checkinRequest(app, "GET", "/api/v1/camp", "", cookie, csrf, "")
	if response.Code != 200 {
		t.Fatalf("camp %d %s", response.Code, response.Body)
	}
	var camp checkin.Camp
	if err := json.Unmarshal(response.Body.Bytes(), &camp); err != nil {
		t.Fatal(err)
	}
	if len(camp.Tasks) != 1 || camp.Tasks[0].UnlockActivities == nil {
		t.Fatalf("camp=%s", response.Body)
	}
}
