package httpapi

import (
	"database/sql"
	"testing"
)

// islandUnlockTask writes explicit identities so activity rules never depend on task names.
func islandUnlockTask(t *testing.T, db *sql.DB, id string, enabled bool) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO tasks(id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,created_at,updated_at) VALUES(?,?,'task-star-v1',0,0,3,1,?,0,0)`, id, id, enabled)
	if err != nil {
		t.Fatal(err)
	}
}

// islandUnlockRecord inserts a real effective record independently of today's task schedule.
func islandUnlockRecord(t *testing.T, db *sql.DB, id, taskID, day string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,source,created_at,updated_at) VALUES(?,?,?,?,'task-star-v1',0,0,'backfill',0,0)`, id, taskID, day, taskID)
	if err != nil {
		t.Fatal(err)
	}
}

// islandUnlockSQL fails the current test on a fixture mutation error.
func islandUnlockSQL(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
