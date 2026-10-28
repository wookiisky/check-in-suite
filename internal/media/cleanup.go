package media

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// cleanupFile identifies bytes already reserved for deletion in a completed short transaction.
type cleanupFile struct {
	ID  string // Database media identity.
	Key string // Server-generated basename inside the private media directory.
}

// Cleanup retries interrupted deletions and removes sufficiently old unregistered files.
func (s *Service) Cleanup(ctx context.Context) error {
	cutoff := s.Now().Add(-s.Config.MediaOrphanTTL)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,storage_key FROM media_files m WHERE
 (state='deleting' OR (state='ready' AND COALESCE(unreferenced_at,created_at)<=?))
 AND NOT EXISTS(SELECT 1 FROM checkins c WHERE c.deleted_at IS NULL AND (c.photo_media_id=m.id OR c.audio_media_id=m.id))
 ORDER BY created_at,id LIMIT 100`, cutoff.UnixMilli())
	if err != nil {
		return err
	}
	var files []cleanupFile
	for rows.Next() {
		var file cleanupFile
		if err := rows.Scan(&file.ID, &file.Key); err != nil {
			rows.Close()
			return err
		}
		files = append(files, file)
	}
	rowError := rows.Err()
	rows.Close()
	if rowError != nil {
		return rowError
	}
	for _, file := range files {
		if _, err := tx.ExecContext(ctx, "UPDATE media_files SET state='deleting' WHERE id=?", file.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	var failures []error
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		if filepath.Base(file.Key) != file.Key || file.Key == "." {
			failures = append(failures, errors.New("invalid stored media key"))
			continue
		}
		err := os.Remove(filepath.Join(s.Config.MediaDirectory, file.Key))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
			continue
		}
		if _, err := s.DB.ExecContext(ctx, "UPDATE media_files SET state='deleted' WHERE id=? AND state='deleting'", file.ID); err != nil {
			failures = append(failures, err)
		}
	}
	for _, directory := range []string{s.Config.MediaDirectory, s.Config.TempDirectory} {
		if err := s.cleanOrphans(ctx, directory, cutoff); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// cleanOrphans checks age, the in-flight registry and the database immediately before deleting a file.
func (s *Service) cleanOrphans(ctx context.Context, directory string, cutoff time.Time) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		s.mu.Lock()
		if s.active[path] {
			s.mu.Unlock()
			continue
		}
		var count int
		err = s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM media_files WHERE storage_key=?", entry.Name()).Scan(&count)
		if err == nil && count == 0 {
			err = os.Remove(path)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		}
		s.mu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}

// RunCleanup owns one bounded periodic loop; the caller waits for it before closing SQLite.
func (s *Service) RunCleanup(ctx context.Context) {
	ticker := time.NewTicker(s.Config.MediaCleanupInterval)
	defer ticker.Stop()
	for {
		if err := s.Cleanup(ctx); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "媒体清理失败", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
