package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

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
