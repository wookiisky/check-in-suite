package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// validateStoragePaths separates the SQLite file from the two nonrecursive orphan cleanup directories.
func (cfg Config) validateStoragePaths() error {
	database, err := resolvedStoragePath(cfg.DatabasePath)
	if err != nil {
		return fmt.Errorf("resolve database_path: %w", err)
	}
	directory := filepath.Dir(database)
	databaseInfo, err := os.Stat(directory)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect database directory: %w", err)
	}
	for name, path := range map[string]string{"media_directory": cfg.MediaDirectory, "temp_directory": cfg.TempDirectory} {
		resolved, err := resolvedStoragePath(path)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", name, err)
		}
		info, err := os.Stat(resolved)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect %s: %w", name, err)
		}
		if resolved == directory || (databaseInfo != nil && info != nil && os.SameFile(databaseInfo, info)) {
			return fmt.Errorf("%s must not contain database_path", name)
		}
	}
	return nil
}

// resolvedStoragePath resolves existing aliases while preserving missing descendants on first deployment.
func resolvedStoragePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	ancestor, suffix := absolute, ""
	for {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			return filepath.Join(resolved, suffix), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		// A configured alias may already exist before its target is created on first startup.
		if info, statErr := os.Lstat(ancestor); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(ancestor)
			if err != nil {
				return "", err
			}
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(ancestor), target)
			}
			resolved, err := resolvedStoragePath(target)
			if err != nil {
				return "", err
			}
			return filepath.Join(resolved, suffix), nil
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", err
		}
		suffix = filepath.Join(filepath.Base(ancestor), suffix)
		ancestor = parent
	}
}
