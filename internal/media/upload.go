package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// Upload accepts a bounded stream and performs all expensive processing before a short write transaction.
func (s *Service) Upload(ctx context.Context, p account.Principal, kind string, source io.Reader) (Media, error) {
	limit, err := s.limit(kind)
	if err != nil {
		return Media{}, err
	}
	raw, release, err := s.temporary(s.Config.TempDirectory)
	if err != nil {
		return Media{}, err
	}
	defer release()
	if _, err := copyContext(ctx, raw, source, limit); err != nil {
		return Media{}, err
	}
	if err := raw.Close(); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	return s.process(ctx, p, kind, raw.Name())
}

// UploadMultipart streams exactly one file and kind in either field order with no unbounded form buffering.
func (s *Service) UploadMultipart(ctx context.Context, p account.Principal, body io.Reader, boundary string) (Media, error) {
	reader := multipart.NewReader(body, boundary)
	raw, release, err := s.temporary(s.Config.TempDirectory)
	if err != nil {
		return Media{}, err
	}
	defer release()
	var kind string
	var hasFile, hasKind bool
	var size int64
	limit := max(s.Config.Limits.PhotoBytesMax, s.Config.Limits.AudioBytesMax)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var oversized *http.MaxBytesError
			if errors.As(err, &oversized) {
				return Media{}, core.Fail(413, "MEDIA_TOO_LARGE")
			}
			return Media{}, core.Fail(400, "INVALID_REQUEST")
		}
		switch part.FormName() {
		case "kind":
			if hasKind {
				part.Close()
				return Media{}, core.Fail(400, "INVALID_REQUEST")
			}
			hasKind = true
			var value strings.Builder
			_, err = copyContext(ctx, &value, part, 16)
			kind = value.String()
		case "file":
			if hasFile {
				part.Close()
				return Media{}, core.Fail(400, "INVALID_REQUEST")
			}
			hasFile = true
			size, err = copyContext(ctx, raw, part, limit)
		default:
			part.Close()
			return Media{}, core.Fail(400, "INVALID_REQUEST")
		}
		part.Close()
		if err != nil {
			return Media{}, err
		}
	}
	if !hasKind || !hasFile {
		return Media{}, core.Fail(400, "INVALID_REQUEST")
	}
	// Consume the complete body so trailing multipart epilogues cannot bypass the HTTP byte cap.
	if _, err := copyContext(ctx, io.Discard, body, 64<<10); err != nil {
		return Media{}, err
	}
	limit, err = s.limit(kind)
	if err != nil {
		return Media{}, err
	}
	if size > limit {
		return Media{}, core.Fail(413, "MEDIA_TOO_LARGE")
	}
	if err := raw.Close(); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	return s.process(ctx, p, kind, raw.Name())
}

// limit restricts uploads to the two configured media kinds.
func (s *Service) limit(kind string) (int64, error) {
	switch kind {
	case "photo":
		return s.Config.Limits.PhotoBytesMax, nil
	case "audio":
		return s.Config.Limits.AudioBytesMax, nil
	default:
		return 0, core.Invalid("kind", "INVALID_MEDIA")
	}
}

// temporary protects a fresh raw or processed file until its owner has finished using it.
func (s *Service) temporary(directory string) (*os.File, func(), error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, nil, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	f, err := os.CreateTemp(directory, ".upload-")
	if err != nil {
		return nil, nil, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	finish := s.protect(f.Name())
	return f, func() { f.Close(); os.Remove(f.Name()); finish() }, nil
}

// process validates bytes and publishes a single immutable key before recording its ready state.
func (s *Service) process(ctx context.Context, p account.Principal, kind, rawPath string) (Media, error) {
	select {
	case s.work <- struct{}{}:
		defer func() { <-s.work }()
	case <-ctx.Done():
		return Media{}, ctx.Err()
	}
	processed, release, err := s.temporary(s.Config.MediaDirectory)
	if err != nil {
		return Media{}, err
	}
	defer release()
	var result Media
	if kind == "photo" {
		result, err = s.photo(rawPath, processed)
	} else {
		result, err = s.audio(ctx, rawPath, processed)
	}
	if err != nil {
		return Media{}, err
	}
	if err := ctx.Err(); err != nil {
		return Media{}, err
	}
	if err := processed.Sync(); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	if _, err := processed.Seek(0, io.SeekStart); err != nil {
		return Media{}, err
	}
	hash := sha256.New()
	size, err := io.Copy(hash, processed)
	if err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	limit, _ := s.limit(kind)
	if size == 0 {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	if size > limit {
		return Media{}, core.Fail(413, "MEDIA_TOO_LARGE")
	}
	if err := processed.Close(); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	result.ID = core.ID()
	result.Kind = kind
	result.SizeBytes = size
	key := result.ID + ".media"
	finalPath := filepath.Join(s.Config.MediaDirectory, key)
	finish := s.protect(finalPath)
	defer finish()
	if err := os.Rename(processed.Name(), finalPath); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	// A registration failure leaves an orphan for bounded cleanup, never a successful response.
	if err := syncDirectory(s.Config.MediaDirectory); err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Media{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err := account.Authorize(ctx, tx, p, false, now); err != nil {
		return Media{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO media_files(id,storage_key,kind,mime_type,size_bytes,duration_ms,width,height,sha256,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'ready',?)`, result.ID, key, kind, result.MIMEType, size, result.DurationMS, result.Width, result.Height, hex.EncodeToString(hash.Sum(nil)), now.UnixMilli())
	if err != nil {
		return Media{}, err
	}
	if err := tx.Commit(); err != nil {
		return Media{}, err
	}
	result.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	return result, nil
}

// syncDirectory makes the completed rename durable before SQLite advertises a usable upload.
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
