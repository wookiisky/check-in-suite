package httpapi

import "testing"

// TestAchievementTitleHTTP checks the selection and revocation contract through real HTTP and SQLite.
func TestAchievementTitleHTTP(t *testing.T) {
	f := newAchievementHTTPFixture(t)
	taskID := f.task(nil)["id"].(string)
	record := f.checkin(taskID, "title-record")
	first := f.success(f.request("POST", "/management/achievements", f.rule("首个成就", "count", "all"), "title-first"), 201)
	second := f.success(f.request("POST", "/management/achievements", f.rule("另一个成就", "count", "all"), "title-second"), 201)
	lockedRule := f.rule("未达标成就", "count", "all")
	lockedRule["target"] = 2
	locked := f.success(f.request("POST", "/management/achievements", lockedRule, "title-locked"), 201)

	assertTitle := func(path, field string, id any) {
		t.Helper()
		result := f.success(f.request("GET", path, nil, ""), 200)
		title, present := result[field]
		if !present || (id == nil && title != nil) {
			t.Fatalf("%s %s=%+v, want %v", path, field, title, id)
		}
		if id != nil {
			value, ok := title.(map[string]any)
			if !ok || value["id"] != id {
				t.Fatalf("%s %s=%+v, want %v", path, field, title, id)
			}
		}
	}
	camp := f.success(f.request("GET", "/camp", nil, ""), 200)
	earned, ok := camp["earned_achievements"].([]any)
	if !ok || len(earned) != 2 || len(camp["achievements"].([]any)) != 0 {
		t.Fatalf("camp must return all earned badges independently of equipment: %+v", camp)
	}
	assertTitle("/camp", "achievement_title", nil)
	for _, item := range []map[string]any{first, first, second} {
		result := f.success(f.request("PUT", "/achievements/title", map[string]any{"achievement_id": item["id"]}, ""), 200)
		title, ok := result["title"].(map[string]any)
		if !ok || title["id"] != item["id"] || title["name"] != item["name"] {
			t.Fatalf("unexpected title: %+v", result)
		}
		assertTitle("/camp", "achievement_title", item["id"])
		assertTitle("/achievements", "title", item["id"])
	}
	for _, rejected := range []struct {
		body map[string]any // Desired selection that cannot be accepted.
		code int            // Expected HTTP status.
	}{
		{map[string]any{}, 400},
		{map[string]any{"achievement_id": ""}, 400},
		{map[string]any{"achievement_id": locked["id"]}, 409},
	} {
		response := f.request("PUT", "/achievements/title", rejected.body, "")
		if response.Code != rejected.code {
			t.Fatalf("selection %+v: got %d, want %d: %s", rejected.body, response.Code, rejected.code, response.Body)
		}
	}
	assertTitle("/camp", "achievement_title", second["id"])
	f.success(f.request("PUT", "/achievements/title", map[string]any{"achievement_id": nil}, ""), 200)
	assertTitle("/camp", "achievement_title", nil)
	f.success(f.request("PUT", "/achievements/title", map[string]any{"achievement_id": second["id"]}, ""), 200)
	f.success(f.request("DELETE", "/checkins/"+record["id"].(string), map[string]any{"expected_version": 1}, ""), 200)
	assertTitle("/camp", "achievement_title", nil)
	f.checkin(taskID, "title-reearned")
	assertTitle("/achievements", "title", nil)
}
