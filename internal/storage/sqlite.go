// Package storage owns the SQLite connection and explicit schema migrations.
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

// Open configures every physical connection and verifies persistent WAL mode.
func Open(ctx context.Context, path string, busyTimeout time.Duration) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	query := url.Values{"_txlock": {"immediate"}}
	query.Add("_pragma", "foreign_keys(ON)")
	query.Add("_pragma", "busy_timeout("+strconv.FormatInt(busyTimeout.Milliseconds(), 10)+")")
	query.Add("_pragma", "synchronous(FULL)")
	dsn := url.URL{Scheme: "file", Path: filepath.ToSlash(absolute), RawQuery: query.Encode()}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}
	if mode != "wal" {
		db.Close()
		return nil, fmt.Errorf("expected WAL journal mode, got %q", mode)
	}
	return db, nil
}
