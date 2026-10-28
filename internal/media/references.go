// Package media owns private uploads, attachment references and eventual file cleanup.
package media

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// References contains the one photograph and one recording belonging to a record.
type References struct {
	PhotoID *string // Nil means no photograph.
	AudioID *string // Nil means no recording.
}

// Replace validates the complete change before changing state inside the caller's record transaction.
// Previous references must come from that record, not from a client-supplied ownership claim.
func Replace(ctx context.Context, tx *sql.Tx, previous, next References, now time.Time, retention time.Duration) error {
	old := []*string{previous.PhotoID, previous.AudioID}
	updated := []*string{next.PhotoID, next.AudioID}
	kinds := []string{"photo", "audio"}
	for i, id := range updated {
		if id == nil {
			continue
		}
		var kind, state string
		var created int64
		var unreferenced sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT kind,state,created_at,unreferenced_at FROM media_files WHERE id=?", *id).Scan(&kind, &state, &created, &unreferenced)
		if errors.Is(err, sql.ErrNoRows) {
			return core.Fail(422, "INVALID_MEDIA")
		}
		if err != nil {
			return err
		}
		if kind != kinds[i] || unreferenced.Valid {
			return core.Fail(422, "INVALID_MEDIA")
		}
		retained := old[i] != nil && *old[i] == *id
		if retained {
			if state != "attached" {
				return core.Fail(422, "INVALID_MEDIA")
			}
		} else if state != "ready" || created <= now.Add(-retention).UnixMilli() {
			return core.Fail(422, "INVALID_MEDIA")
		}
	}
	for i, id := range old {
		if id != nil && (updated[i] == nil || *id != *updated[i]) {
			if _, err := tx.ExecContext(ctx, "UPDATE media_files SET state='ready',unreferenced_at=? WHERE id=? AND state='attached'", now.UnixMilli(), *id); err != nil {
				return err
			}
		}
	}
	for i, id := range updated {
		if id != nil && (old[i] == nil || *id != *old[i]) {
			if _, err := tx.ExecContext(ctx, "UPDATE media_files SET state='attached' WHERE id=?", *id); err != nil {
				return err
			}
		}
	}
	return nil
}
