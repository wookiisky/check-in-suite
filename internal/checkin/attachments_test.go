package checkin

import (
	"context"
	"testing"
	"time"
)

// readyPhoto registers a previously validated upload; decoding and files are tested by the media module.
func readyPhoto(t *testing.T, f fixture, id string) {
	t.Helper()
	_, err := f.s.DB.Exec("INSERT INTO media_files(id,storage_key,kind,mime_type,size_bytes,width,height,sha256,state,created_at) VALUES(?,?,'photo','image/png',20,1,1,'sample','ready',?)", id, id+".png", f.s.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
}

// TestAttachmentChangesShareRecordTransaction preserves old references on failed replacement.
func TestAttachmentChangesShareRecordTransaction(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 3)
	photo := "photo-one"
	readyPhoto(t, f, photo)
	input := CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", PhotoMediaID: &photo}
	got, err := f.s.Create(ctx, f.p, false, "with-photo", input)
	if err != nil {
		t.Fatal(err)
	}
	if got.Checkin.PhotoMediaID == nil || *got.Checkin.PhotoMediaID != photo || !got.Checkin.CanEdit || !got.Checkin.CanDelete {
		t.Fatalf("%+v", got)
	}
	_, err = f.s.Create(ctx, f.p, false, "reuse-photo", input)
	code(t, err, "INVALID_MEDIA")
	missing := "unknown-photo"
	_, err = f.s.Edit(ctx, f.p, false, got.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "failed", PhotoMediaID: &missing})
	code(t, err, "INVALID_MEDIA")
	var state string
	if err = f.s.DB.QueryRow("SELECT state FROM media_files WHERE id=?", photo).Scan(&state); err != nil || state != "attached" {
		t.Fatalf("%s %v", state, err)
	}
	edited, err := f.s.Edit(ctx, f.p, false, got.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "only text", PhotoMediaID: &photo})
	if err != nil || edited.Version != 2 || edited.CoinRewardSnapshot != 10 {
		t.Fatalf("%+v %v", edited, err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, got.Checkin.ID, 2); err != nil {
		t.Fatal(err)
	}
	var unreferenced int64
	if err = f.s.DB.QueryRow("SELECT state,unreferenced_at FROM media_files WHERE id=?", photo).Scan(&state, &unreferenced); err != nil || state != "ready" || unreferenced == 0 {
		t.Fatalf("%s %d %v", state, unreferenced, err)
	}
	replay, err := f.s.Create(ctx, f.p, false, "with-photo", input)
	if err != nil || !replay.Checkin.Deleted || replay.Checkin.CanEdit || replay.Checkin.CanDelete {
		t.Fatalf("%+v %v", replay, err)
	}
	assertLedger(t, f.s.DB)
}

// TestCommittedUploadReplaysAfterRetention checks original commands before expired-upload validation.
func TestCommittedUploadReplaysAfterRetention(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	photo := "photo-committed"
	readyPhoto(t, f, photo)
	in := CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", PhotoMediaID: &photo}
	got, err := f.s.Create(ctx, f.p, false, "old-upload", in)
	if err != nil {
		t.Fatal(err)
	}
	f.s.Now = func() time.Time { return time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC) }
	replay, err := f.s.Create(ctx, f.p, false, "old-upload", in)
	if err != nil || replay.Checkin.ID != got.Checkin.ID || replay.Checkin.CanEdit {
		t.Fatalf("%+v %v", replay, err)
	}
}
