package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestIslandActivityAccessHTTP verifies live eligibility, deletion and configuration using file SQLite and actual JSON.
func TestIslandActivityAccessHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	now := time.Now()
	app.RegisterIsland(island.New(app.DB, func() time.Time { return now }))
	read := func() island.State {
		t.Helper()
		response := request("GET", "/api/v1/island", "", "")
		var state island.State
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

// TestIslandActivityAccessMidnightAndSave uses server date boundaries and checks save responses carry fresh eligibility.
func TestIslandActivityAccessMidnightAndSave(t *testing.T) {
	app, request := shopHTTPRequest(t)
	zone, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		t.Fatal(err)
	}
	local := time.Now().In(zone)
	now := time.Date(local.Year(), local.Month(), local.Day(), 23, 59, 59, 0, zone)
	clockCalls := 0
	app.RegisterIsland(island.New(app.DB, func() time.Time { clockCalls++; return now }))
	islandUnlockTask(t, app.DB, "sport", true)
	islandUnlockSQL(t, app.DB, `INSERT INTO task_island_activities VALUES('sport','run')`)
	islandUnlockRecord(t, app.DB, "sport-today", "sport", core.Today(now))
	response := request("GET", "/api/v1/island", "", "")
	var state island.State
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &state) != nil {
		t.Fatalf("read: %d %s", response.Code, response.Body)
	}
	if clockCalls != 1 {
		t.Fatalf("clock sampled %d times in one operation", clockCalls)
	}
	expires, err := time.Parse(time.RFC3339, state.ExpiresAt)
	if err != nil || !expires.Equal(now.Add(time.Second)) || state.Today != core.Today(now) {
		t.Fatalf("boundary today=%s expires=%s error=%v", state.Today, state.ExpiresAt, err)
	}
	for _, access := range state.ActivityAccess {
		if access.Activity == "run" && !access.Available {
			t.Fatal("today's record did not unlock running")
		}
	}
	now = now.Add(time.Second)
	body, err := json.Marshal(island.SaveInput{ExpectedVersion: state.Version, Placements: state.Placements})
	if err != nil {
		t.Fatal(err)
	}
	response = request("PUT", "/api/v1/island", string(body), "")
	var saved island.State
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &saved) != nil {
		t.Fatalf("save: %d %s", response.Code, response.Body)
	}
	if clockCalls != 2 || saved.Today != core.Today(now) || saved.ExpiresAt == state.ExpiresAt {
		t.Fatalf("stale save eligibility: %+v clock=%d", saved, clockCalls)
	}
	for _, access := range saved.ActivityAccess {
		if access.Activity == "run" && access.Available {
			t.Fatal("yesterday's record unlocked the new day")
		}
	}
}
