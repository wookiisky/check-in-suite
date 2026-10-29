package storage

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
)

// DatabaseStatus describes observed database compatibility without changing the database.
type DatabaseStatus struct {
	State         string `json:"state"`            // missing, empty, pending, current, incompatible, or newer.
	DatabasePath  string `json:"database_path"`    // Absolute configured SQLite path.
	Applied       int    `json:"applied"`          // Number of committed migration history rows.
	Expected      int    `json:"expected"`         // Number of migrations embedded in this executable.
	AccountExists bool   `json:"account_exists"`   // An account is present in this snapshot.
	DemoComplete  bool   `json:"demo_complete"`    // Version one of the demo seed committed completely.
	Reason        string `json:"reason,omitempty"` // Stable detail for an incompatible history or structure.
}

// Inspect opens an existing database read-only and classifies compatibility independently of operational failures.
func Inspect(ctx context.Context, path string, files fs.FS) (DatabaseStatus, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return DatabaseStatus{}, fmt.Errorf("resolve database path: %w", err)
	}
	expected, err := loadMigrations(files)
	if err != nil {
		return DatabaseStatus{}, err
	}
	status := DatabaseStatus{State: "missing", DatabasePath: absolute, Expected: len(expected)}
	info, err := os.Stat(absolute)
	if os.IsNotExist(err) {
		return status, nil
	}
	if err != nil {
		return status, fmt.Errorf("inspect database path: %w", err)
	}
	if !info.Mode().IsRegular() {
		return status, fmt.Errorf("database path is not a regular file: %s", absolute)
	}
	// mode=ro observes committed WAL data; immutable=1 would incorrectly ignore an active WAL.
	dsn := url.URL{Scheme: "file", Path: filepath.ToSlash(absolute), RawQuery: url.Values{"mode": {"ro"}}.Encode()}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return status, fmt.Errorf("open read-only database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return status, fmt.Errorf("read database snapshot: %w", err)
	}
	defer tx.Rollback()
	if err := inspectIntegrity(ctx, tx); err != nil {
		return status, err
	}
	actual, err := inspectObjects(ctx, tx)
	if err != nil {
		return status, err
	}
	if len(actual) == 0 {
		status.State = "empty"
		return status, nil
	}
	if _, ok := actual["schema_migrations"]; !ok {
		status.State, status.Reason = "incompatible", "migration_history_missing"
		return status, nil
	}
	if err := inspectHistory(ctx, tx, expected, &status); err != nil {
		return status, err
	}
	if status.State == "incompatible" || status.State == "newer" {
		return status, nil
	}
	if err := inspectStructure(ctx, expected[:status.Applied], actual, &status); err != nil {
		return status, err
	}
	if status.State == "incompatible" {
		return status, nil
	}
	if _, ok := actual["accounts"]; ok {
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM accounts)").Scan(&status.AccountExists); err != nil {
			return status, fmt.Errorf("inspect account: %w", err)
		}
	}
	if _, ok := actual["demo_seeds"]; ok {
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM demo_seeds WHERE version=1)").Scan(&status.DemoComplete); err != nil {
			return status, fmt.Errorf("inspect demo seed: %w", err)
		}
	}
	status.State = "pending"
	if status.Applied == status.Expected {
		status.State = "current"
	}
	return status, nil
}

// inspectIntegrity reports corruption as an error, never as a reason to reset automatically.
func inspectIntegrity(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "PRAGMA quick_check")
	if err != nil {
		return fmt.Errorf("check database integrity: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			return err
		}
		if result != "ok" {
			return fmt.Errorf("database integrity check failed: %s", result)
		}
	}
	return rows.Err()
}

// inspectObjects captures declared schema objects while excluding SQLite's generated objects.
func inspectObjects(ctx context.Context, tx *sql.Tx) (map[string]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
	if err != nil {
		return nil, fmt.Errorf("inspect database schema: %w", err)
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var name, source string
		if err := rows.Scan(&name, &source); err != nil {
			return nil, err
		}
		result[name] = source
	}
	return result, rows.Err()
}

// inspectHistory distinguishes a compatible prefix, modified history, and a database from a newer executable.
func inspectHistory(ctx context.Context, tx *sql.Tx, expected []migration, status *DatabaseStatus) error {
	// A legacy history table with different columns is a contract mismatch, not an I/O failure.
	columns, err := tx.QueryContext(ctx, "PRAGMA table_info(schema_migrations)")
	if err != nil {
		return err
	}
	names := map[string]bool{}
	for columns.Next() {
		var position, notNull, primaryKey int
		var name, kind string
		var defaultValue any
		if err := columns.Scan(&position, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			columns.Close()
			return err
		}
		names[name] = true
	}
	err = columns.Err()
	columns.Close()
	if err != nil {
		return err
	}
	if !names["version"] || !names["name"] || !names["checksum"] {
		status.State, status.Reason = "incompatible", "migration_history_format"
		return nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT version,name,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf("inspect migration history: %w", err)
	}
	defer rows.Close()
	mismatch := false
	newer := false
	for rows.Next() {
		var version int
		var name, checksum string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return fmt.Errorf("read migration history: %w", err)
		}
		index := status.Applied
		status.Applied++
		if index >= len(expected) {
			newer = true
			continue
		}
		want := expected[index]
		if version != want.version || name != want.name || checksum != want.checksum {
			mismatch = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	switch {
	case mismatch:
		status.State, status.Reason = "incompatible", "migration_history_mismatch"
	case newer:
		status.State, status.Reason = "newer", "database_version_newer"
	}
	return nil
}

// inspectStructure derives expected tables and indexes from migrations without changing the inspected database.
func inspectStructure(ctx context.Context, applied []migration, actual map[string]string, status *DatabaseStatus) error {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range applied {
		if _, err := tx.ExecContext(ctx, item.source); err != nil {
			return fmt.Errorf("derive schema for inspection: %w", err)
		}
	}
	expected, err := inspectObjects(ctx, tx)
	if err != nil {
		return err
	}
	for name, source := range expected {
		if actual[name] != source {
			status.State, status.Reason = "incompatible", "schema_structure_mismatch"
			return nil
		}
	}
	if status.Applied == 0 {
		status.State, status.Reason = "incompatible", "migration_history_empty"
	}
	return nil
}
