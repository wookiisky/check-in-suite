// Package idempotency stores only committed command results beside their business facts.
package idempotency

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Result contains a minimal replay payload, not a copy of private record content.
type Result struct {
	ResourceID string          // Stable identity created by the original command.
	Status     int             // Original HTTP success status.
	JSON       json.RawMessage // Small economic result or identity.
}

// Hash binds a typed, normalized request to its operation and API generation.
func Hash(operation string, input any) (string, error) {
	data, err := json.Marshal(struct {
		API       string
		Operation string
		Input     any
	}{"v1", operation, input})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// Lookup must run after authorization and before mutable business validation.
func Lookup(ctx context.Context, tx *sql.Tx, operation, key, hash string) (*Result, error) {
	if strings.TrimSpace(key) == "" || len(key) > 128 {
		return nil, core.Invalid("idempotency_key", "INVALID_IDEMPOTENCY_KEY")
	}
	var savedHash string
	var r Result
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT request_hash,resource_id,http_status,response_json FROM idempotency_requests WHERE account_id=1 AND operation=? AND key=?", operation, key).Scan(&savedHash, &r.ResourceID, &r.Status, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hash != savedHash {
		return nil, core.Fail(409, "IDEMPOTENCY_CONFLICT")
	}
	r.JSON = json.RawMessage(raw)
	return &r, nil
}

// Save participates in the caller's transaction so an uncommitted command cannot replay success.
func Save(ctx context.Context, tx *sql.Tx, operation, key, hash, id string, status int, result any, now time.Time) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO idempotency_requests(account_id,operation,key,request_hash,resource_id,http_status,response_json,created_at) VALUES(1,?,?,?,?,?,?,?)", operation, key, hash, id, status, string(data), now.UnixMilli())
	return err
}
