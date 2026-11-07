package idempotency

import (
	"context"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestAccountScope exercises the actual receipt key and serialized replay across accounts.
func TestAccountScope(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, t.TempDir()+"/receipts.db", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.ExecContext(ctx, `CREATE TABLE idempotency_requests(account_id INTEGER NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, http_status INTEGER NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id,operation,key)) STRICT`)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, accountID := range []int64{1, 2} {
		result, err := Lookup(ctx, tx, accountID, "create", "same-key", "same-hash")
		if err != nil || result != nil {
			t.Fatalf("account %d initial lookup: %#v %v", accountID, result, err)
		}
		if err := Save(ctx, tx, accountID, "create", "same-key", "same-hash", "resource", 201, map[string]int64{"owner": accountID}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	for _, accountID := range []int64{1, 2} {
		result, err := Lookup(ctx, tx, accountID, "create", "same-key", "same-hash")
		expected := `{"owner":1}`
		if accountID == 2 {
			expected = `{"owner":2}`
		}
		if err != nil || result == nil || string(result.JSON) != expected {
			t.Fatalf("account %d replay: %#v %v", accountID, result, err)
		}
		if _, err := Lookup(ctx, tx, accountID, "create", "same-key", "different-hash"); err == nil {
			t.Fatal("different body reused receipt")
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
