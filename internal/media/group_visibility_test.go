package media

import (
	"bytes"
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
)

// TestGroupMediaVisibility shares only effective record attachments and rechecks membership on every read.
func TestGroupMediaVisibility(t *testing.T) {
	s, owner := mediaFixture(t)
	ctx := context.Background()
	member := mediaAccount(t, s, "member")
	outsider := mediaAccount(t, s, "outsider")
	if _, err := s.DB.Exec("INSERT INTO groups(id,name) VALUES(1,'same'),(2,'other')"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=CASE WHEN username='outsider' THEN 2 ELSE 1 END"); err != nil {
		t.Fatal(err)
	}
	upload, err := s.Upload(ctx, owner, "photo", bytes.NewReader(pngFixture(t, 3, 2)))
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Open(ctx, member, upload.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	mediaCode(t, s.Cancel(ctx, member, upload.ID), "MEDIA_UNAVAILABLE")
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("UPDATE media_files SET state='attached' WHERE id=?", upload.ID); err != nil {
		t.Fatal(err)
	}
	insertAttachedRecord(t, tx, upload.ID)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []account.Principal{owner, member} {
		_, file, err := s.Open(ctx, p, upload.ID)
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	_, _, err = s.Open(ctx, outsider, upload.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=NULL WHERE username='media-test'"); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Open(ctx, member, upload.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=1 WHERE username='media-test'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=NULL WHERE username='member'"); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Open(ctx, member, upload.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=1 WHERE username='member'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE checkins SET deleted_at=? WHERE photo_media_id=?", fixtureTime.UnixMilli(), upload.ID); err != nil {
		t.Fatal(err)
	}
	for _, p := range []account.Principal{owner, member} {
		_, _, err := s.Open(ctx, p, upload.ID)
		mediaCode(t, err, "MEDIA_UNAVAILABLE")
	}
}

// TestAttachmentOwnership rejects another account's upload even when the accounts share a group.
func TestAttachmentOwnership(t *testing.T) {
	s, owner := mediaFixture(t)
	ctx := context.Background()
	other := mediaAccount(t, s, "another")
	upload, err := s.Upload(ctx, other, "photo", bytes.NewReader(pngFixture(t, 2, 3)))
	if err != nil {
		t.Fatal(err)
	}
	_, file, err := s.Open(ctx, other, upload.ID)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	_, _, err = s.Open(ctx, owner, upload.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	mediaCode(t, s.Cancel(ctx, owner, upload.ID), "MEDIA_UNAVAILABLE")
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = Replace(ctx, tx, owner.AccountID, References{}, References{PhotoID: &upload.ID}, fixtureTime, s.Config.MediaOrphanTTL)
	mediaCode(t, err, "INVALID_MEDIA")
	tx.Rollback()
	if _, err := s.DB.Exec("INSERT INTO groups(id,name) VALUES(1,'same')"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE accounts SET group_id=1"); err != nil {
		t.Fatal(err)
	}
	tx, err = s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = Replace(ctx, tx, owner.AccountID, References{}, References{PhotoID: &upload.ID}, fixtureTime, s.Config.MediaOrphanTTL)
	mediaCode(t, err, "INVALID_MEDIA")
	tx.Rollback()
	if err := s.Cancel(ctx, other, upload.ID); err != nil {
		t.Fatal(err)
	}
}

// mediaAccount creates another authenticated account in the same real service database.
func mediaAccount(t *testing.T, s *Service, username string) account.Principal {
	t.Helper()
	ctx := context.Background()
	if err := s.Accounts.Initialize(ctx, username, username, "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := s.Accounts.Login(ctx, username, "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
