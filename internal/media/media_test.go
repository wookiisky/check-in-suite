package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// TestPhotoLifecycle verifies real decoding, private preview, cancellation and physical cleanup.
func TestPhotoLifecycle(t *testing.T) {
	s, p := mediaFixture(t)
	ctx := context.Background()
	result, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 12, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "photo" || result.MIMEType != "image/png" || *result.Width != 12 || *result.Height != 8 || result.DurationMS != nil {
		t.Fatalf("%+v", result)
	}
	_, f, err := s.Open(ctx, p, result.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(f); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := s.Cancel(ctx, p, result.ID); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Open(ctx, p, result.ID)
	mediaCode(t, err, "MEDIA_UNAVAILABLE")
	s.Now = func() time.Time { return fixtureTime.Add(25 * time.Hour) }
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var state, key string
	if err := s.DB.QueryRow("SELECT state,storage_key FROM media_files WHERE id=?", result.ID).Scan(&state, &key); err != nil {
		t.Fatal(err)
	}
	if state != "deleted" {
		t.Fatal(state)
	}
	if _, err := os.Stat(filepath.Join(s.Config.MediaDirectory, key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file remained: %v", err)
	}
}

// TestPhotoValidation checks real bytes and dimensions rather than client MIME declarations.
func TestPhotoValidation(t *testing.T) {
	s, p := mediaFixture(t)
	s.Config.Limits.PhotoBytesMax = 80
	_, err := s.Upload(context.Background(), p, "photo", bytes.NewReader(make([]byte, 81)))
	mediaCode(t, err, "MEDIA_TOO_LARGE")
	s.Config.Limits.PhotoBytesMax = 10 << 20
	_, err = s.Upload(context.Background(), p, "photo", bytes.NewBufferString("not a photograph"))
	mediaCode(t, err, "INVALID_MEDIA")
	s.Config.Limits.PhotoPixelsMax = 95
	_, err = s.Upload(context.Background(), p, "photo", bytes.NewReader(pngFixture(t, 12, 8)))
	mediaCode(t, err, "INVALID_MEDIA")
	s.Config.Limits.PhotoPixelsMax = 1000
	s.Config.Limits.PhotoEdgeMax = 6
	result, err := s.Upload(context.Background(), p, "photo", bytes.NewReader(pngFixture(t, 12, 8)))
	if err != nil || *result.Width != 6 || *result.Height != 4 {
		t.Fatalf("%+v %v", result, err)
	}
}

// TestAttachmentReplacement validates both new references before changing either old one.
func TestAttachmentReplacement(t *testing.T) {
	s, p := mediaFixture(t)
	ctx := context.Background()
	first, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 2, 2)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Upload(ctx, p, "photo", bytes.NewReader(pngFixture(t, 3, 3)))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := Replace(ctx, tx, References{}, References{PhotoID: &first.ID}, fixtureTime, s.Config.MediaOrphanTTL); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel(ctx, p, first.ID); err == nil {
		t.Fatal("cancel accepted attached media")
	}
	tx, err = s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = Replace(ctx, tx, References{PhotoID: &first.ID}, References{PhotoID: &second.ID, AudioID: &second.ID}, fixtureTime, s.Config.MediaOrphanTTL)
	mediaCode(t, err, "INVALID_MEDIA")
	tx.Rollback()
	var state string
	if err := s.DB.QueryRow("SELECT state FROM media_files WHERE id=?", first.ID).Scan(&state); err != nil || state != "attached" {
		t.Fatalf("%s %v", state, err)
	}
	tx, err = s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := Replace(ctx, tx, References{PhotoID: &first.ID}, References{PhotoID: &first.ID}, fixtureTime.Add(48*time.Hour), s.Config.MediaOrphanTTL); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
}

// mediaCode compares stable protocol codes without testing localized copy.
func mediaCode(t *testing.T, err error, code string) {
	t.Helper()
	var got *core.Error
	if !errors.As(err, &got) || got.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
