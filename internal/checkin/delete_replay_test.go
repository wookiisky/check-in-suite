package checkin

import (
	"context"
	"testing"
	"time"
)

// TestDeleteReplayAcrossMidnight recovers a lost success without another reward reversal or weaker authorization.
func TestDeleteReplayAcrossMidnight(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	now := time.Date(2026, 10, 29, 15, 59, 59, 0, time.UTC)
	f.s.Now = func() time.Time { return now }
	f.s.Accounts.Now = f.s.Now
	input := CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: task.Version}
	deleted, err := f.s.Create(ctx, f.p, false, "deleted-before-midnight", input)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := f.s.Create(ctx, f.p, false, "retained-before-midnight", input)
	if err != nil {
		t.Fatal(err)
	}
	original, err := f.s.Delete(ctx, f.p, false, deleted.Checkin.ID, deleted.Checkin.Version)
	if err != nil {
		t.Fatal(err)
	}
	var version, updatedAt int64
	if err := f.s.DB.QueryRow("SELECT version,updated_at FROM checkins WHERE id=?", deleted.Checkin.ID).Scan(&version, &updatedAt); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	for range 2 {
		replayed, err := f.s.Delete(ctx, f.p, false, deleted.Checkin.ID, deleted.Checkin.Version)
		if err != nil {
			t.Fatalf("replay after Taipei midnight: %v", err)
		}
		if replayed != original {
			t.Fatalf("replayed=%+v original=%+v", replayed, original)
		}
	}
	var currentVersion, currentUpdatedAt, reversals int64
	if err := f.s.DB.QueryRow("SELECT version,updated_at FROM checkins WHERE id=?", deleted.Checkin.ID).Scan(&currentVersion, &currentUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE event_type='checkin_revoke' AND checkin_id=?", deleted.Checkin.ID).Scan(&reversals); err != nil {
		t.Fatal(err)
	}
	if currentVersion != version || currentUpdatedAt != updatedAt || reversals != 1 {
		t.Fatalf("replay changed record or ledger: version=%d updated_at=%d reversals=%d", currentVersion, currentUpdatedAt, reversals)
	}
	_, err = f.s.Delete(ctx, f.p, false, retained.Checkin.ID, retained.Checkin.Version)
	code(t, err, "HISTORY_READ_ONLY")
	_, err = f.s.Delete(ctx, f.p, true, deleted.Checkin.ID, deleted.Checkin.Version)
	code(t, err, "MANAGEMENT_REQUIRED")
	assertLedger(t, f.s.DB)
	if err := f.s.Accounts.Logout(ctx, f.p); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Delete(ctx, f.p, false, deleted.Checkin.ID, deleted.Checkin.Version)
	code(t, err, "SESSION_REQUIRED")
}
