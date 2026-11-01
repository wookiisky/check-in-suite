package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestIslandActivityAccessHTTP verifies live eligibility, deletion and configuration using file SQLite and actual JSON.
func TestIndependentIslandActivityAccessHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	now := time.Now()
	app.RegisterIsland(island.New(app.DB, func() time.Time { return now }))
	read := func() island.ActivityAccessState {
		t.Helper()
		response := request("GET", "/api/v1/island/activity-access", "", "")
		var state island.ActivityAccessState
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &state) != nil {
			t.Fatalf("read: %d %s", response.Code, response.Body)
		}
		if state.Today != core.Today(now) || state.ExpiresAt == "" || len(state.ActivityAccess) != 3 {
			t.Fatalf("incomplete eligibility response: %s", response.Body)
		}
		for _, access := range state.ActivityAccess {
			if access.Tasks == nil {
				t.Fatalf("tasks serialized as null: %s", response.Body)
			}
		}
		return state
	}
	assertAvailable := func(activity string, available bool, tasks int) {
		t.Helper()
		for _, access := range read().ActivityAccess {
			if access.Activity == activity {
				if access.Available != available || len(access.Tasks) != tasks {
					t.Fatalf("%s eligibility: %+v want available=%v tasks=%d", activity, access, available, tasks)
				}
				return
			}
		}
		t.Fatalf("missing activity %s", activity)
	}
	assertAvailable("read", true, 0)
	islandUnlockTask(t, app.DB, "arbitrary-name-one", true)
	islandUnlockTask(t, app.DB, "arbitrary-name-two", false)
	islandUnlockSQL(t, app.DB, `INSERT INTO task_island_activities VALUES('arbitrary-name-one','read'),('arbitrary-name-two','read')`)
	assertAvailable("read", false, 2)
	assertAvailable("run", true, 0)
	// Yesterday's backfill never unlocks today's activity.
	islandUnlockRecord(t, app.DB, "historical", "arbitrary-name-one", core.Today(now.AddDate(0, 0, -1)))
	assertAvailable("read", false, 2)
	// A disabled task's existing record remains valid, even outside its current weekday schedule.
	islandUnlockRecord(t, app.DB, "disabled-task-record", "arbitrary-name-two", core.Today(now))
	assertAvailable("read", true, 2)
	islandUnlockRecord(t, app.DB, "other-record", "arbitrary-name-one", core.Today(now))
	islandUnlockSQL(t, app.DB, `UPDATE checkins SET deleted_at=1 WHERE id='disabled-task-record'`)
	assertAvailable("read", true, 2)
	islandUnlockSQL(t, app.DB, `UPDATE checkins SET deleted_at=1 WHERE id='other-record'`)
	assertAvailable("read", false, 2)
	islandUnlockSQL(t, app.DB, `UPDATE tasks SET enabled=0 WHERE id='arbitrary-name-one'`)
	assertAvailable("read", false, 2)
	islandUnlockSQL(t, app.DB, `UPDATE tasks SET deleted_at=1 WHERE id='arbitrary-name-one'`)
	assertAvailable("read", false, 1)
	islandUnlockSQL(t, app.DB, `UPDATE tasks SET deleted_at=1 WHERE id='arbitrary-name-two'`)
	assertAvailable("read", true, 0)
}

// TestIndependentIslandActivityAccessBoundary keeps a single clock sample and never consults layout or purchases.
func TestIndependentIslandActivityAccessBoundary(t *testing.T) {
	app, request := shopHTTPRequest(t)
	zone, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		t.Fatal(err)
	}
	local := time.Now().In(zone)
	now := time.Date(local.Year(), local.Month(), local.Day(), 23, 59, 59, 0, zone)
	calls := 0
	app.RegisterIsland(island.New(app.DB, func() time.Time { calls++; return now }))
	islandUnlockTask(t, app.DB, "running", true)
	islandUnlockSQL(t, app.DB, `INSERT INTO task_island_activities VALUES('running','run')`)
	islandUnlockRecord(t, app.DB, "today", "running", core.Today(now))
	islandUnlockSQL(t, app.DB, `DROP TABLE island_state`)
	islandUnlockSQL(t, app.DB, `DROP TABLE purchases`)
	for _, available := range []bool{true, false} {
		response := request("GET", "/api/v1/island/activity-access", "", "")
		var state island.ActivityAccessState
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &state) != nil {
			t.Fatalf("independent read: %d %s", response.Code, response.Body)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 3 {
			t.Fatalf("eligibility leaked layout fields: %s", response.Body)
		}
		expires, err := time.Parse(time.RFC3339, state.ExpiresAt)
		if err != nil || core.Today(now) != state.Today || !expires.After(now) {
			t.Fatalf("invalid time boundary: %+v error=%v", state, err)
		}
		for _, access := range state.ActivityAccess {
			if access.Activity == "run" && access.Available != available {
				t.Fatalf("running eligibility=%v want %v", access.Available, available)
			}
		}
		now = now.Add(time.Second)
	}
	if calls != 2 {
		t.Fatalf("clock sampled %d times for two requests", calls)
	}
	unauthenticated := apiRequest(app, "GET", "/api/v1/island/activity-access", "", nil, "")
	if unauthenticated.Code != 401 {
		t.Fatalf("unauthenticated: %d %s", unauthenticated.Code, unauthenticated.Body)
	}
	// Authentication at the route is insufficient: the service must recheck expiry at its own transaction instant.
	now = now.AddDate(1, 0, 0)
	response := request("GET", "/api/v1/island/activity-access", "", "")
	if response.Code != 401 {
		t.Fatalf("expired transaction session: %d %s", response.Code, response.Body)
	}
}
