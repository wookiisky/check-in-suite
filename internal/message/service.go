// Package message owns private household notes with stable pagination and idempotent creation.
package message

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
)

// Service stores household notes in the same database as the authenticated account.
type Service struct {
	DB     *sql.DB          // Shared application database, accessed through short transactions.
	Config config.Config    // Confirmed Unicode length limit.
	Now    func() time.Time // Injectable operation clock, read once inside each transaction.
}

// Message is a private immutable note; removing it does not affect other business facts.
type Message struct {
	ID        string `json:"id"`         // Stable server-generated identity.
	Text      string `json:"text"`       // Trimmed plain-text content.
	CreatedAt string `json:"created_at"` // Actual creation instant in RFC3339.
}

// CreateInput accepts only note content, never a caller-selected owner or timestamp.
type CreateInput struct {
	Text string `json:"text"` // Content to normalize and validate by Unicode code point.
}

// Page explicitly reports whether older notes remain to be fetched.
type Page struct {
	Items      []Message `json:"items"`       // Newest first, using ID as a timestamp tie-breaker.
	NextCursor *string   `json:"next_cursor"` // Null when all notes have been returned.
}

// receipt retains creation identity without copying the family's private note into replay storage.
type receipt struct {
	ID        string `json:"id"`         // Original successful message identity.
	CreatedAt string `json:"created_at"` // Original successful creation instant.
}

// cursor preserves the two-part ordering even when several notes share one millisecond.
type cursor struct {
	Created int64  `json:"created"` // Millisecond timestamp of the last emitted note.
	ID      string `json:"id"`      // Last emitted note's deterministic tie-breaker.
}

// New binds note operations to the existing database and explicit settings.
func New(db *sql.DB, cfg config.Config) *Service { return &Service{DB: db, Config: cfg, Now: time.Now} }

// Create commits the note and its compact replay receipt in the same authorized transaction.
func (s *Service) Create(ctx context.Context, p account.Principal, key string, input CreateInput) (Message, error) {
	var out Message
	input.Text = strings.TrimSpace(input.Text)
	hash, err := idempotency.Hash("message.create", input)
	if err != nil {
		return out, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err := account.Authorize(ctx, tx, p, false, now); err != nil {
		return out, err
	}
	saved, err := idempotency.Lookup(ctx, tx, "message.create", key, hash)
	if err != nil {
		return out, err
	}
	if saved != nil {
		var previous receipt
		if err := json.Unmarshal(saved.JSON, &previous); err != nil {
			return out, err
		}
		// The matching request supplies its own text; a later deletion never causes re-insertion.
		return Message{ID: previous.ID, Text: input.Text, CreatedAt: previous.CreatedAt}, nil
	}
	if err := core.Text("text", input.Text, 1, s.Config.Limits.MessageMax); err != nil {
		return out, err
	}
	out = Message{ID: core.ID(), Text: input.Text, CreatedAt: core.Timestamp(now.UnixMilli())}
	if _, err := tx.ExecContext(ctx, "INSERT INTO messages(id,text,created_at) VALUES(?,?,?)", out.ID, out.Text, now.UnixMilli()); err != nil {
		return Message{}, err
	}
	if err := idempotency.Save(ctx, tx, "message.create", key, hash, out.ID, 201, receipt{out.ID, out.CreatedAt}, now); err != nil {
		return Message{}, err
	}
	return out, tx.Commit()
}

// Delete is repeatable and authorizes the session inside the mutation transaction.
func (s *Service) Delete(ctx context.Context, p account.Principal, id string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}

// List reads one bounded page in a consistent snapshot and emits a cursor only when needed.
func (s *Service) List(ctx context.Context, p account.Principal, after string, limit int) (Page, error) {
	out := Page{Items: []Message{}}
	if limit < 1 || limit > 100 {
		return out, core.Invalid("limit", "INVALID_NUMBER")
	}
	var position cursor
	if after != "" {
		raw, err := base64.RawURLEncoding.DecodeString(after)
		if err != nil || json.Unmarshal(raw, &position) != nil || position.ID == "" {
			return out, core.Invalid("cursor", "INVALID_CURSOR")
		}
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return out, err
	}
	query := "SELECT id,text,created_at FROM messages"
	args := []any{}
	if after != "" {
		query += " WHERE (created_at,id)<(?,?)"
		args = append(args, position.Created, position.ID)
	}
	query += " ORDER BY created_at DESC,id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item Message
		var created int64
		if err := rows.Scan(&item.ID, &item.Text, &created); err != nil {
			rows.Close()
			return out, err
		}
		item.CreatedAt = core.Timestamp(created)
		out.Items = append(out.Items, item)
		if len(out.Items) == limit {
			position = cursor{Created: created, ID: item.ID}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		raw, err := json.Marshal(position)
		if err != nil {
			return out, err
		}
		next := base64.RawURLEncoding.EncodeToString(raw)
		out.NextCursor = &next
	}
	return out, tx.Commit()
}
