package media

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// TestCleanupPreservesUnownedFiles keeps an old real database and unrelated files outside the media namespace.
func TestCleanupPreservesUnownedFiles(t *testing.T) {
	for _, directoryKind := range []string{"media", "temporary"} {
		t.Run(directoryKind, func(t *testing.T) {
			s, _ := mediaFixture(t)
			directory := filepath.Dir(s.Config.DatabasePath)
			if directoryKind == "media" {
				s.Config.MediaDirectory = directory
			} else {
				s.Config.TempDirectory = directory
			}
			old := fixtureTime.Add(-49 * time.Hour)
			if _, err := s.DB.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
				t.Fatal(err)
			}
			preserved := []string{s.Config.DatabasePath}
			for _, name := range []string{"notes.txt", "unknown.media", ".upload-notes", ".upload-", "island.db-wal", "island.db-shm"} {
				path := filepath.Join(directory, name)
				// SQLite owns its existing sidecars; never replace their contents.
				if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
					if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				preserved = append(preserved, path)
			}
			for _, path := range preserved {
				if err := os.Chtimes(path, old, old); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.Cleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			for _, path := range preserved {
				if _, err := os.Stat(path); err != nil {
					t.Errorf("unowned file removed: %s: %v", filepath.Base(path), err)
				}
			}
			var accounts int
			if err := s.DB.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&accounts); err != nil || accounts != 1 {
				t.Fatalf("database lost: accounts=%d error=%v", accounts, err)
			}
		})
	}
}

// TestCleanupOwnedOrphans preserves active and recent files while removing both generated orphan forms.
func TestCleanupOwnedOrphans(t *testing.T) {
	s, _ := mediaFixture(t)
	for _, directory := range []string{s.Config.MediaDirectory, s.Config.TempDirectory} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		temporary, err := os.CreateTemp(directory, ".upload-")
		if err != nil {
			t.Fatal(err)
		}
		if err := temporary.Close(); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{core.ID() + ".media", filepath.Base(temporary.Name())} {
			path := filepath.Join(directory, name)
			if err := os.WriteFile(path, []byte("orphan"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := s.Cleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("recent file removed: %v", err)
			}
			old := fixtureTime.Add(-49 * time.Hour)
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
			finish := s.protect(path)
			if err := s.Cleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("active file removed: %v", err)
			}
			finish()
			if err := s.Cleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("owned orphan remained: %v", err)
			}
		}
	}
}
