package main

import (
	"fmt"
	"os"
)

// removeDatabaseFiles clears only the configured database and sidecars while the service is stopped.
func removeDatabaseFiles(path string) error {
	for _, filename := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Remove(filename); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove database file %s: %w", filename, err)
		}
	}
	return nil
}
