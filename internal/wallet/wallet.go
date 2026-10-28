// Package wallet keeps balances and their immutable economic events in one transaction.
package wallet

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

const (
	CheckinGrant  = "checkin_grant"
	CheckinRevoke = "checkin_revoke"
	PurchaseDebit = "purchase_debit"
)

// Balance exposes only the current spendable currencies and their confirmation version.
type Balance struct {
	Coins    int64 `json:"coins"`    // Spendable coins, including negative balances after revocation.
	Diamonds int64 `json:"diamonds"` // Spendable diamonds.
	Version  int64 `json:"version"`  // Changes once per economic event.
}

// Event carries a single auditable change; the caller owns its transaction.
type Event struct {
	Type       string    // Grant, revocation or purchase debit.
	ResourceID string    // Record or purchase that owns this unique event.
	Coins      int64     // Signed coin movement.
	Diamonds   int64     // Signed diamond movement.
	At         time.Time // Transaction's fixed operation time.
}

// Get reads the balance from the caller's existing transaction snapshot.
func Get(ctx context.Context, tx *sql.Tx) (Balance, error) {
	var b Balance
	err := tx.QueryRowContext(ctx, "SELECT coins,diamonds,version FROM wallets WHERE account_id=1").Scan(&b.Coins, &b.Diamonds, &b.Version)
	return b, err
}

// Apply writes one immutable event and advances both currencies without overflowing JSON integers.
func Apply(ctx context.Context, tx *sql.Tx, event Event) (Balance, error) {
	b, err := Get(ctx, tx)
	if err != nil {
		return b, err
	}
	coins, err := core.Add(b.Coins, event.Coins)
	if err != nil {
		return b, err
	}
	diamonds, err := core.Add(b.Diamonds, event.Diamonds)
	if err != nil {
		return b, err
	}
	var checkinID, purchaseID any
	if event.Type == PurchaseDebit {
		purchaseID = event.ResourceID
	} else {
		checkinID = event.ResourceID
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO wallet_entries(id,account_id,event_type,checkin_id,purchase_id,coin_delta,diamond_delta,created_at) VALUES(?,1,?,?,?,?,?,?)", core.ID(), event.Type, checkinID, purchaseID, event.Coins, event.Diamonds, event.At.UnixMilli()); err != nil {
		return b, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE wallets SET coins=?,diamonds=?,version=version+1 WHERE account_id=1", coins, diamonds); err != nil {
		return b, err
	}
	return Balance{Coins: coins, Diamonds: diamonds, Version: b.Version + 1}, nil
}
