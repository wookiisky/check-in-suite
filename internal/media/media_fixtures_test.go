package media

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

var fixtureTime = time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)

// mediaFixture keeps every test on a real isolated SQLite file and private directory.
func mediaFixture(t *testing.T) (*Service, account.Principal) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Defaults()
	cfg.DatabasePath = filepath.Join(dir, "island.db")
	cfg.MediaDirectory = filepath.Join(dir, "media")
	cfg.TempDirectory = filepath.Join(dir, "tmp")
	cfg.FFprobePath = "ffprobe"
	cfg.MediaProbeTimeout = 3 * time.Second
	db, err := storage.Open(context.Background(), cfg.DatabasePath, 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	accounts := account.New(db, cfg)
	accounts.Now = func() time.Time { return fixtureTime }
	if err := accounts.Initialize(context.Background(), "media-test", "测试", "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := accounts.Login(context.Background(), "media-test", "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := accounts.Authenticate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	s := New(db, accounts, cfg)
	s.Now = func() time.Time { return fixtureTime }
	return s, p
}

// pngFixture creates a small real image with distinguishable colored corners.
func pngFixture(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.NRGBA{uint8(x * 17), uint8(y * 23), 71, 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// pausedReader pauses the first real stream read to establish an upload-versus-revocation race.
type pausedReader struct {
	Reader   io.Reader     // Actual fixture bytes consumed after the gate opens.
	Entered  chan struct{} // Signals that upload started before the password reset.
	Continue chan struct{} // Releases the first read after credential invalidation.
	Started  bool          // Prevents blocking on subsequent reads.
}

// Read exposes a deterministic boundary without changing the production upload implementation.
func (r *pausedReader) Read(buffer []byte) (int, error) {
	if !r.Started {
		r.Started = true
		close(r.Entered)
		<-r.Continue
	}
	return r.Reader.Read(buffer)
}
