package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"time"
)

// migration is an immutable SQL file and its expected identity.
type migration struct {
	version  int    // Sequential, one-based migration number.
	name     string // Filename retained in the database history.
	checksum string // SHA-256 of the exact SQL bytes.
	source   string // SQL executed in the migration transaction.
}

// loadMigrations validates ordering so missing or duplicate version files cannot be skipped.
func loadMigrations(files fs.FS) ([]migration, error) {
	names, err := fs.Glob(files, "*.sql")
	if err != nil {
		return nil, err
	}
	pattern := regexp.MustCompile(`^(\d{3})_[a-z0-9_]+\.sql$`)
	result := make([]migration, 0, len(names))
	for index, name := range names {
		parts := pattern.FindStringSubmatch(name)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid migration filename %q", name)
		}
		version, err := strconv.Atoi(parts[1])
		if err != nil || version != index+1 {
			return nil, fmt.Errorf("migration sequence must start at 001 without gaps: %s", name)
		}
		source, err := fs.ReadFile(files, name)
		if err != nil {
			return nil, err
		}
		result = append(result, migration{version, name, fmt.Sprintf("%x", sha256.Sum256(source)), string(source)})
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("no schema migrations found")
	}
	return result, nil
}

// readHistory validates applied files and returns the number already committed.
func readHistory(ctx context.Context, tx *sql.Tx, expected []migration) (int, error) {
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT version, name, checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var version int
		var name, checksum string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return 0, err
		}
		if count >= len(expected) {
			return 0, fmt.Errorf("database contains migration newer than this executable: %s", name)
		}
		want := expected[count]
		if version != want.version || name != want.name || checksum != want.checksum {
			return 0, fmt.Errorf("migration history mismatch at version %d", version)
		}
		count++
	}
	return count, rows.Err()
}

// Migrate applies all pending SQL and history rows atomically; serving never calls this function.
func Migrate(ctx context.Context, db *sql.DB, files fs.FS) error {
	all, err := loadMigrations(files)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	applied, err := readHistory(ctx, tx, all)
	if err != nil {
		return err
	}
	for _, item := range all[applied:] {
		if _, err := tx.ExecContext(ctx, item.source); err != nil {
			return fmt.Errorf("apply migration %s: %w", item.name, err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)", item.version, item.name, item.checksum, time.Now().UTC().UnixMilli()); err != nil {
			return fmt.Errorf("record migration %s: %w", item.name, err)
		}
	}
	return tx.Commit()
}

// CheckSchema requires an exact match without applying or changing any migration.
func CheckSchema(ctx context.Context, db *sql.DB, files fs.FS) error {
	all, err := loadMigrations(files)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	applied, err := readHistory(ctx, tx, all)
	if err != nil {
		return err
	}
	if applied != len(all) {
		return fmt.Errorf("schema has %d of %d migrations; run the migrate command", applied, len(all))
	}
	return tx.Commit()
}
