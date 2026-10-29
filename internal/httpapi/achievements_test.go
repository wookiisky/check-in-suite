package httpapi

import (
	"net/http"
	"testing"
)

// TestAchievementsHTTPPreservesTaskHistoryAndRevokesDeletedEvidence verifies the complete ownership contract.
func TestAchievementsHTTPPreservesTaskHistoryAndRevokesDeletedEvidence(t *testing.T) {
	f := newAchievementHTTPFixture(t)
	category := f.success(f.request("POST", "/management/categories", map[string]any{"name": "成就分类"}, "achievement-category"), 201)
	task := f.task(category["id"])
	taskID := task["id"].(string)
	record := f.checkin(taskID, "achievement-record")
	rule := f.rule("分类阅读徽章", "coins", "category")
	rule["category_id"], rule["target"] = category["id"], 7
	created := f.success(f.request("POST", "/management/achievements", rule, "achievement-create"), 201)
	id := created["id"].(string)
	if created["qualified"] != true || created["progress"] != float64(7) || created["earned_at"] == nil || created["equipped"] != false {
		t.Fatalf("historical qualification: %+v", created)
	}
	replay := f.success(f.request("POST", "/management/achievements", rule, "achievement-create"), 201)
	if replay["id"] != id {
		t.Fatalf("replayed creation duplicated achievement: %+v", replay)
	}
	f.success(f.request("PUT", "/achievements/"+id+"/equipment", map[string]any{"equipped": true}, ""), 200)
	f.success(f.request("PUT", "/achievements/"+id+"/equipment", map[string]any{"equipped": true}, ""), 200)
	f.success(f.request("DELETE", "/management/tasks/"+taskID, map[string]any{"expected_version": 1}, ""), 204)
	item := f.item(id)
	if item["qualified"] != true || item["equipped"] != true || item["progress"] != float64(7) {
		t.Fatalf("task deletion lost historical contribution: %+v", item)
	}
	// A second configuration write forces a subsequent evaluation after the task was deleted.
	rule["expected_version"] = created["version"]
	f.success(f.request("PATCH", "/management/achievements/"+id, rule, ""), 200)
	item = f.item(id)
	if item["qualified"] != true || item["equipped"] != true {
		t.Fatalf("later recalculation lost deleted task facts: %+v", item)
	}
	// Deleting the now-empty category preserves the historical identity used by the achievement.
	f.success(f.request("DELETE", "/management/categories/"+category["id"].(string), map[string]any{"expected_version": 1}, ""), 204)
	options := f.success(f.request("GET", "/management/achievements/options", nil, ""), 200)
	retainedCategory, retainedTask := false, false
	for _, value := range options["categories"].([]any) {
		choice := value.(map[string]any)
		if choice["id"] == category["id"] && choice["deleted"] == true {
			retainedCategory = true
		}
	}
	for _, value := range options["tasks"].([]any) {
		choice := value.(map[string]any)
		if choice["id"] == taskID && choice["deleted"] == true && choice["category_id"] == category["id"] {
			retainedTask = true
		}
	}
	if !retainedCategory || !retainedTask {
		t.Fatalf("deleted options cannot explain retained achievement: %+v", options)
	}
	camp := f.success(f.request("GET", "/camp", nil, ""), 200)
	if equipped := camp["achievements"].([]any); len(equipped) != 1 || equipped[0].(map[string]any)["id"] != id {
		t.Fatalf("camp lost equipped badge: %+v", camp["achievements"])
	}
	for range 2 {
		f.success(f.request("DELETE", "/checkins/"+record["id"].(string), map[string]any{"expected_version": 1}, ""), 200)
	}
	item = f.item(id)
	if item["qualified"] != false || item["equipped"] != false || item["progress"] != float64(0) {
		t.Fatalf("deleted evidence did not revoke and unequip atomically: %+v", item)
	}
	camp = f.success(f.request("GET", "/camp", nil, ""), 200)
	if equipped := camp["achievements"].([]any); len(equipped) != 0 {
		t.Fatalf("revoked badge still visible: %+v", equipped)
	}
	if response := f.request("PUT", "/achievements/"+id+"/equipment", map[string]any{"equipped": true}, ""); response.Code != 409 {
		t.Fatalf("unqualified badge equipped: %d %s", response.Code, response.Body)
	}
}

// TestAchievementsHTTPProtocolRejectsIncompleteAndForgedRules checks real JSON and permission boundaries.
func TestAchievementsHTTPProtocolRejectsIncompleteAndForgedRules(t *testing.T) {
	f := newAchievementHTTPFixture(t)
	rule := f.rule("协议徽章", "count", "all")
	for _, field := range []string{"name", "asset_key", "metric", "scope", "category_id", "task_ids", "target", "window_days", "enabled"} {
		t.Run("missing-"+field, func(t *testing.T) {
			body := f.rule("协议徽章", "count", "all")
			delete(body, field)
			response := f.request("POST", "/management/achievements", body, "missing-"+field)
			if response.Code != 400 {
				t.Fatalf("missing %s accepted: %d %s", field, response.Code, response.Body)
			}
		})
	}
	for _, change := range []struct {
		field string // Input whose wire representation is invalid or not client-owned.
		value any    // Serialized invalid value.
	}{
		{"qualified", true}, {"equipped", true}, {"progress", 99},
		{"target", 0}, {"target", 1.5}, {"target", nil},
		{"window_days", 0}, {"window_days", 1.5},
		{"metric", "script"}, {"scope", "unknown"}, {"task_ids", nil},
		{"asset_key", "fox-v1"}, {"scope", "tasks"}, {"scope", "category"},
	} {
		body := f.rule("协议徽章", "count", "all")
		body[change.field] = change.value
		response := f.request("POST", "/management/achievements", body, "invalid-rule")
		if response.Code != 400 {
			t.Fatalf("invalid %s=%v accepted: %d %s", change.field, change.value, response.Code, response.Body)
		}
	}
	created := f.success(f.request("POST", "/management/achievements", rule, "valid-rule"), 201)
	id := created["id"].(string)
	if created["category_id"] != nil || created["window_days"] != nil || created["earned_at"] != nil || len(created["task_ids"].([]any)) != 0 {
		t.Fatalf("nullable and empty wire values: %+v", created)
	}
	if response := f.request("PUT", "/achievements/"+id+"/equipment", map[string]any{}, ""); response.Code != 400 {
		t.Fatalf("missing equipped value accepted: %d %s", response.Code, response.Body)
	}
	rule["expected_version"] = 0
	if response := f.request("PATCH", "/management/achievements/"+id, rule, ""); response.Code != 409 {
		t.Fatalf("stale edit accepted: %d %s", response.Code, response.Body)
	}
	f.success(f.request("POST", "/management/lock", nil, ""), 204)
	for _, path := range []string{"/management/achievements", "/management/achievements/options"} {
		if response := f.request("GET", path, nil, ""); response.Code != 403 {
			t.Fatalf("locked management read %s: %d %s", path, response.Code, response.Body)
		}
	}
	delete(rule, "expected_version")
	if response := f.request("POST", "/management/achievements", rule, "locked-rule"); response.Code != 403 {
		t.Fatalf("locked creation accepted: %d %s", response.Code, response.Body)
	}
	f.success(f.request("GET", "/achievements", nil, ""), 200)
	if response := apiRequest(f.app, http.MethodGet, "/api/v1/achievements", "", nil, ""); response.Code != 401 {
		t.Fatalf("unauthenticated achievement read: %d %s", response.Code, response.Body)
	}
}

// TestAchievementsHTTPWindowAndReacquisition uses real facts to distinguish days, counts and reward totals.
func TestAchievementsHTTPWindowAndReacquisition(t *testing.T) {
	f := newAchievementHTTPFixture(t)
	task := f.task(nil)
	taskID := task["id"].(string)
	first := f.checkin(taskID, "window-first")
	f.checkin(taskID, "window-second")
	for _, metric := range []string{"count", "days", "coins", "diamonds"} {
		rule := f.rule("窗口-"+metric, metric, "tasks")
		rule["task_ids"], rule["window_days"] = []string{taskID}, 1
		rule["target"] = map[string]int{"count": 2, "days": 2, "coins": 14, "diamonds": 6}[metric]
		created := f.success(f.request("POST", "/management/achievements", rule, "window-"+metric), 201)
		wantProgress := map[string]float64{"count": 2, "days": 1, "coins": 14, "diamonds": 6}[metric]
		if created["progress"] != wantProgress || created["qualified"] != (metric != "days") {
			t.Fatalf("%s progress has wrong serialized semantics: %+v", metric, created)
		}
		if metric == "count" {
			id := created["id"].(string)
			f.success(f.request("PUT", "/achievements/"+id+"/equipment", map[string]any{"equipped": true}, ""), 200)
			f.success(f.request("DELETE", "/checkins/"+first["id"].(string), map[string]any{"expected_version": 1}, ""), 200)
			if item := f.item(id); item["qualified"] != false || item["equipped"] != false {
				t.Fatalf("expected revoked badge: %+v", item)
			}
			f.checkin(taskID, "window-replacement")
			if item := f.item(id); item["qualified"] != true || item["equipped"] != false {
				t.Fatalf("reacquired badge must stay unequipped: %+v", item)
			}
		}
	}
}
