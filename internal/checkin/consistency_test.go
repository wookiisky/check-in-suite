package checkin

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// TestNegativeBalanceRetainsPurchase proves revocation is independent of previous spending.
func TestNegativeBalanceRetainsPurchase(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 1)
	got, err := f.s.Create(ctx, f.p, false, "grant", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('product','reward','奖励','gift-v1',8,0,1,0,0); INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('purchase','product','reward','奖励','','gift-v1',8,0,'pending',0)"); err != nil {
		t.Fatal(err)
	}
	if _, err = wallet.Apply(ctx, tx, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: "purchase", Coins: -8, At: f.s.Now()}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	deleted, err := f.s.Delete(ctx, f.p, false, got.Checkin.ID, 1)
	if err != nil || deleted.Wallet.Coins != -8 || deleted.Wallet.Diamonds != 0 {
		t.Fatalf("%+v %v", deleted, err)
	}
	var count int
	if err = f.s.DB.QueryRow("SELECT count(*) FROM purchases WHERE id='purchase' AND status='pending'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("purchase lost: %d %v", count, err)
	}
	assertLedger(t, f.s.DB)
}

// TestRollbackAfterRecordInsert leaves no reward, record or replay success after a database failure.
func TestRollbackAfterRecordInsert(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 1)
	if _, err := f.s.DB.Exec("CREATE TRIGGER fail_reward BEFORE INSERT ON wallet_entries BEGIN SELECT RAISE(ABORT,'injected write failure'); END"); err != nil {
		t.Fatal(err)
	}
	input := CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"}
	if _, err := f.s.Create(ctx, f.p, false, "rollback", input); err == nil {
		t.Fatal("injected failure succeeded")
	}
	for _, table := range []string{"checkins", "wallet_entries"} {
		var count int
		if err := f.s.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count=%d %v", table, count, err)
		}
	}
	var count int
	if err := f.s.DB.QueryRow("SELECT count(*) FROM idempotency_requests WHERE operation='checkin.create'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("false receipt: %d %v", count, err)
	}
	if _, err := f.s.DB.Exec("DROP TRIGGER fail_reward"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Create(ctx, f.p, false, "rollback", input); err != nil {
		t.Fatal(err)
	}
	assertLedger(t, f.s.DB)
}

// TestIntegerOverflowAndZeroEvents exercise exact integer bounds and auditable zero grants.
func TestIntegerOverflowAndZeroEvents(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 1)
	if _, err := f.s.DB.Exec("UPDATE wallets SET coins=?", core.MaxInteger); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.Create(ctx, f.p, false, "overflow", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
	code(t, err, "INTEGER_OVERFLOW")
	var count int
	if err = f.s.DB.QueryRow("SELECT count(*) FROM checkins").Scan(&count); err != nil || count != 0 {
		t.Fatalf("overflow left record: %d %v", count, err)
	}
	if _, err = f.s.DB.Exec("UPDATE wallets SET coins=0"); err != nil {
		t.Fatal(err)
	}
	in := taskInput(1)
	in.CoinReward = 0
	in.DiamondReward = 0
	in.ExpectedVersion = 1
	if _, err = f.s.UpdateTask(ctx, f.p, task.ID, in); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.Create(ctx, f.p, false, "zero", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 2, ExpectedToday: "2026-10-29"})
	if err != nil || got.Wallet.Coins != 0 || got.Wallet.Version != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	if err = f.s.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE coin_delta=0 AND diamond_delta=0").Scan(&count); err != nil || count != 1 {
		t.Fatalf("zero event missing: %d %v", count, err)
	}
	assertLedger(t, f.s.DB)
}

// TestReplayPrivacyAndAuthorization prevents old request keys bypassing revoked permissions.
func TestReplayPrivacyAndAuthorization(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	in := CreateInput{TaskID: task.ID, BusinessDate: "2026-10-28", ExpectedTaskVersion: 1, Text: "家庭私密内容不复制"}
	got, err := f.s.Create(ctx, f.p, true, "private", in)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err = f.s.DB.QueryRow("SELECT response_json FROM idempotency_requests WHERE operation='checkin.backfill'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, in.Text) {
		t.Fatal("private content copied into receipt")
	}
	var data map[string]any
	if err = json.Unmarshal([]byte(raw), &data); err != nil || data["checkin_id"] != got.Checkin.ID {
		t.Fatalf("receipt %s %v", raw, err)
	}
	if _, err = f.s.Delete(ctx, f.p, true, got.Checkin.ID, 1); err != nil {
		t.Fatal(err)
	}
	replay, err := f.s.Create(ctx, f.p, true, "private", in)
	if err != nil || !replay.Checkin.Deleted || replay.Checkin.Text != "" || replay.Wallet.Coins != 10 {
		t.Fatalf("%+v %v", replay, err)
	}
	if err = f.s.Accounts.Lock(ctx, f.p); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Create(ctx, f.p, true, "private", in)
	code(t, err, "MANAGEMENT_REQUIRED")
}

// TestPaginationAndSnapshot uses identical timestamps and validates every task count against the wallet.
func TestPaginationAndSnapshot(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 100)
	for i := 0; i < 3; i++ {
		if _, err := f.s.Create(ctx, f.p, false, core.ID(), CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"}); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := f.s.List(ctx, f.p, "2026-10-29", "2026-10-29", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, record := range page.Items {
			if seen[record.ID] {
				t.Fatal("duplicate pagination record")
			}
			seen[record.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("records=%d", len(seen))
	}
	_, err := f.s.List(ctx, f.p, "2026-10-01", "2026-11-01", "", 50)
	code(t, err, "INVALID_DATE_RANGE")
	second, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	writer := New(second, account.New(second, config.Defaults()), config.Defaults())
	writer.Now = f.s.Now
	var wg sync.WaitGroup
	wg.Add(1)
	failures := make(chan error, 1)
	go func() {
		defer wg.Done()
		for range 20 {
			_, err := writer.Create(ctx, f.p, false, core.ID(), CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
			if err != nil {
				failures <- err
				return
			}
		}
	}()
	for range 30 {
		camp, err := f.s.Camp(ctx, f.p, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(camp.Tasks) != 1 || camp.Wallet.Coins != (100-camp.Tasks[0].Remaining)*10 {
			t.Fatalf("mixed snapshot: %+v", camp)
		}
	}
	wg.Wait()
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
	assertLedger(t, f.s.DB)
}

// TestMissingAndInvalidConfiguration covers empty, over-limit and malformed business fields.
func TestMissingAndInvalidConfiguration(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	for _, change := range []func(*TaskInput){func(v *TaskInput) { v.Name = " " }, func(v *TaskInput) { v.CoinReward = -1 }, func(v *TaskInput) { v.DiamondReward = 1000001 }, func(v *TaskInput) { v.DailyLimit = 0 }, func(v *TaskInput) { v.Weekdays = nil }, func(v *TaskInput) { v.Weekdays = []int{8} }, func(v *TaskInput) { v.IconKey = "../../private" }} {
		in := taskInput(1)
		change(&in)
		_, err := f.s.CreateTask(ctx, f.p, core.ID(), in)
		code(t, err, "INVALID_REQUEST")
	}
	if _, err := f.s.CreateCategory(ctx, f.p, "blank", CategoryInput{Name: " "}); err == nil {
		t.Fatal("blank category accepted")
	}
	if err := f.s.DeleteTask(ctx, f.p, "missing", 1); err == nil {
		t.Fatal("missing task deleted")
	}
	var violating string
	err := f.s.DB.QueryRow("PRAGMA foreign_key_check").Scan(&violating)
	if err != sql.ErrNoRows {
		t.Fatalf("foreign keys invalid: %v", err)
	}
}

// TestSameKeyAcrossConnections returns one identity even when the task allows more than one record.
func TestSameKeyAcrossConnections(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	second, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	other := New(second, account.New(second, config.Defaults()), config.Defaults())
	other.Now = f.s.Now
	gate, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		result CreateResult
		err    error
	}
	outcomes := make(chan outcome, 2)
	start := make(chan struct{})
	var ready sync.WaitGroup
	ready.Add(2)
	for _, service := range []*Service{f.s, other} {
		go func(service *Service) {
			ready.Done()
			<-start
			result, err := service.Create(ctx, f.p, false, "shared-command", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
			outcomes <- outcome{result, err}
		}(service)
	}
	ready.Wait()
	close(start)
	time.Sleep(20 * time.Millisecond)
	if err := gate.Commit(); err != nil {
		t.Fatal(err)
	}
	first := <-outcomes
	last := <-outcomes
	if first.err != nil || last.err != nil || first.result.Checkin.ID != last.result.Checkin.ID {
		t.Fatalf("first=%+v last=%+v", first, last)
	}
	var count int
	if err := f.s.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE event_type='checkin_grant'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d %v", count, err)
	}
	assertLedger(t, f.s.DB)
}

// TestConfigurationCommitWinsBeforeWaitingCheckin proves eligibility is read after the write lock.
func TestConfigurationCommitWinsBeforeWaitingCheckin(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 1)
	second, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	other := New(second, account.New(second, config.Defaults()), config.Defaults())
	other.Now = f.s.Now
	update, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer update.Rollback()
	if _, err := update.ExecContext(ctx, "UPDATE tasks SET enabled=0,version=version+1 WHERE id=?", task.ID); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		close(started)
		_, err := other.Create(ctx, f.p, false, "waiting-checkin", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
		result <- err
	}()
	<-started
	time.Sleep(20 * time.Millisecond)
	if err := update.Commit(); err != nil {
		t.Fatal(err)
	}
	code(t, <-result, "TASK_UNAVAILABLE")
	var count int
	if err := f.s.DB.QueryRow("SELECT count(*) FROM checkins").Scan(&count); err != nil || count != 0 {
		t.Fatalf("count=%d %v", count, err)
	}
	assertLedger(t, f.s.DB)
}
