package media

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// Media describes validated bytes without revealing private filesystem locations.
type Media struct {
	ID         string `json:"id"`          // Random server-generated identity.
	Kind       string `json:"kind"`        // photo or audio.
	MIMEType   string `json:"mime_type"`   // MIME type detected from the actual content.
	SizeBytes  int64  `json:"size_bytes"`  // Persisted byte count after processing.
	DurationMS *int64 `json:"duration_ms"` // Actual audio duration; nil for photos.
	Width      *int   `json:"width"`       // Processed photo width; nil for audio.
	Height     *int   `json:"height"`      // Processed photo height; nil for audio.
	CreatedAt  string `json:"created_at"`  // Actual upload registration instant.
}

// Service coordinates bounded file work with short SQLite transactions.
type Service struct {
	DB       *sql.DB          // Shared application database; never reacquired during a transaction.
	Accounts *account.Service // Current-session authority.
	Config   config.Config    // Confirmed upload and retention boundaries.
	Now      func() time.Time // Injectable cleanup and registration clock.
	work     chan struct{}    // At most one expensive decode or probe per application instance.
	mu       sync.Mutex       // Protects files still being written or registered.
	active   map[string]bool  // Absolute filenames protected from orphan cleanup.
}

// New creates a media service without starting background work or modifying existing files.
func New(db *sql.DB, accounts *account.Service, cfg config.Config) *Service {
	return &Service{DB: db, Accounts: accounts, Config: cfg, Now: time.Now, work: make(chan struct{}, 1), active: map[string]bool{}}
}

// authorize verifies a live session at the database boundary, including after slow file processing.
func (s *Service) authorize(ctx context.Context, tx *sql.Tx, p account.Principal) error {
	return account.Authorize(ctx, tx, p, false, s.Now())
}

// Open permits active references or unexpired previews and returns only a server-selected file.
func (s *Service) Open(ctx context.Context, p account.Principal, id string) (Media, *os.File, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Media{}, nil, err
	}
	defer tx.Rollback()
	if err := s.authorize(ctx, tx, p); err != nil {
		return Media{}, nil, err
	}
	var m Media
	var key, state string
	var created int64
	var unreferenced sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT id,storage_key,kind,mime_type,size_bytes,duration_ms,width,height,state,created_at,unreferenced_at FROM media_files WHERE id=?`, id).Scan(&m.ID, &key, &m.Kind, &m.MIMEType, &m.SizeBytes, &m.DurationMS, &m.Width, &m.Height, &state, &created, &unreferenced)
	if errors.Is(err, sql.ErrNoRows) {
		return Media{}, nil, core.Fail(404, "MEDIA_UNAVAILABLE")
	}
	if err != nil {
		return Media{}, nil, err
	}
	if unreferenced.Valid || (state != "attached" && (state != "ready" || created <= s.Now().Add(-s.Config.MediaOrphanTTL).UnixMilli())) {
		return Media{}, nil, core.Fail(404, "MEDIA_UNAVAILABLE")
	}
	if state == "attached" {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM checkins WHERE deleted_at IS NULL AND (photo_media_id=? OR audio_media_id=?)", id, id).Scan(&count); err != nil {
			return Media{}, nil, err
		}
		if count != 1 {
			return Media{}, nil, core.Fail(404, "MEDIA_UNAVAILABLE")
		}
	}
	if filepath.Base(key) != key || key == "." {
		return Media{}, nil, core.Fail(404, "MEDIA_UNAVAILABLE")
	}
	f, err := os.Open(filepath.Join(s.Config.MediaDirectory, key))
	if err != nil {
		return Media{}, nil, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	if err := tx.Commit(); err != nil {
		f.Close()
		return Media{}, nil, err
	}
	m.CreatedAt = core.Timestamp(created)
	return m, f, nil
}

// Cancel withdraws only unattached uploads; record edits own attachment removal.
func (s *Service) Cancel(ctx context.Context, p account.Principal, id string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.authorize(ctx, tx, p); err != nil {
		return err
	}
	var state string
	err = tx.QueryRowContext(ctx, "SELECT state FROM media_files WHERE id=?", id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Fail(404, "MEDIA_UNAVAILABLE")
	}
	if err != nil {
		return err
	}
	if state == "attached" {
		return core.Fail(409, "MEDIA_ATTACHED")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE media_files SET unreferenced_at=COALESCE(unreferenced_at,?) WHERE id=? AND state='ready'", s.Now().UnixMilli(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// copyContext checks cancellation between bounded stream reads.
func copyContext(ctx context.Context, destination io.Writer, source io.Reader, limit int64) (int64, error) {
	buffer := make([]byte, 32*1024)
	reader := io.LimitReader(source, limit+1)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := reader.Read(buffer)
		if n > 0 {
			total += int64(n)
			if total > limit {
				return total, core.Fail(413, "MEDIA_TOO_LARGE")
			}
			if _, writeErr := destination.Write(buffer[:n]); writeErr != nil {
				return total, core.Fail(503, "STORAGE_UNAVAILABLE")
			}
		}
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			var oversized *http.MaxBytesError
			if errors.As(err, &oversized) {
				return total, core.Fail(413, "MEDIA_TOO_LARGE")
			}
			return total, err
		}
	}
}

// protect marks a file as in-flight until its caller finishes cleanup or registration.
func (s *Service) protect(path string) func() {
	s.mu.Lock()
	s.active[path] = true
	s.mu.Unlock()
	return func() { s.mu.Lock(); delete(s.active, path); s.mu.Unlock() }
}
