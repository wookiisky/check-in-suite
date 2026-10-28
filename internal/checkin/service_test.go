package checkin

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// fixture uses one file and exposes its path for genuinely independent competing connections.
type fixture struct {
	s    *Service          // Business service under test.
	p    account.Principal // Authenticated and unlocked session.
	path string            // Real SQLite file shared only inside this test.
}

// setup creates an empty application and a real authenticated management session.
func setup(t *testing.T) fixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "checkins.db")
	db, err := storage.Open(ctx, path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	a := account.New(db, config.Defaults())
	now := func() time.Time { return time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC) }
	a.Now = now
	if err := a.Initialize(ctx, "island", "小朋友", "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := a.Login(ctx, "island", "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	s := New(db, a, config.Defaults())
	s.Now = now
	return fixture{s, p, path}
}

// code checks stable error categories without coupling tests to UI wording.
func code(t *testing.T, err error, want string) {
	t.Helper()
	var got *core.Error
	if !errors.As(err, &got) || got.Code != want {
		t.Fatalf("error=%v want %s", err, want)
	}
}

// taskInput provides a task eligible every day, with both currencies and configurable allowance.
func taskInput(limit int64) TaskInput {
	return TaskInput{Name: "阅读", IconKey: "book-v1", CoinReward: 10, DiamondReward: 2, DailyLimit: limit, Weekdays: []int{1, 2, 3, 4, 5, 6, 7}, Enabled: true}
}

// createTask sets up one managed task through the actual service path.
func createTask(t *testing.T, f fixture, limit int64) Task {
	t.Helper()
	v, err := f.s.CreateTask(context.Background(), f.p, "task-key", taskInput(limit))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// TestCheckinLifecycle exercises snapshots, idempotency, editing, deletion and released allowance.
func TestCheckinLifecycle(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 1)
	in := CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: task.Version, Text: "今天读书"}
	got, err := f.s.Create(ctx, f.p, false, "checkin-key", in)
	if err != nil {
		t.Fatal(err)
	}
	if got.Wallet.Coins != 10 || got.Wallet.Diamonds != 2 || got.TaskRemaining != 0 {
		t.Fatalf("%+v", got)
	}
	replay, err := f.s.Create(ctx, f.p, false, "checkin-key", in)
	if err != nil || replay.Checkin.ID != got.Checkin.ID {
		t.Fatalf("%+v %v", replay, err)
	}
	changed := in
	changed.Text = "不同请求"
	_, err = f.s.Create(ctx, f.p, false, "checkin-key", changed)
	code(t, err, "IDEMPOTENCY_CONFLICT")
	_, err = f.s.Create(ctx, f.p, false, "second-key", in)
	code(t, err, "DAILY_LIMIT_REACHED")
	edit, err := f.s.Edit(ctx, f.p, false, got.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "更新内容"})
	if err != nil {
		t.Fatal(err)
	}
	if edit.ID != got.Checkin.ID || edit.CoinRewardSnapshot != 10 || edit.BusinessDate != in.ExpectedToday {
		t.Fatalf("%+v", edit)
	}
	_, err = f.s.Edit(ctx, f.p, false, edit.ID, EditInput{ExpectedVersion: 1})
	code(t, err, "VERSION_CONFLICT")
	deleted, err := f.s.Delete(ctx, f.p, false, edit.ID, 2)
	if err != nil || deleted.Wallet.Coins != 0 {
		t.Fatalf("%+v %v", deleted, err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, edit.ID, 2); err != nil {
		t.Fatal(err)
	}
	camp, err := f.s.Camp(ctx, f.p, "")
	if err != nil || len(camp.Tasks) != 1 {
		t.Fatalf("%+v %v", camp, err)
	}
	assertLedger(t, f.s.DB)
}

// TestDateAuthorityAndReplay proves old successful commands replay before new-date validation.
func TestDateAuthorityAndReplay(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	in := CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}
	got, err := f.s.Create(ctx, f.p, false, "before-midnight", in)
	if err != nil {
		t.Fatal(err)
	}
	f.s.Now = func() time.Time { return time.Date(2026, 10, 29, 16, 0, 0, 0, time.UTC) }
	if _, err = f.s.Create(ctx, f.p, false, "before-midnight", in); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Create(ctx, f.p, false, "after-midnight", in)
	code(t, err, "DAY_CHANGED")
	_, err = f.s.Edit(ctx, f.p, false, got.Checkin.ID, EditInput{ExpectedVersion: 1})
	code(t, err, "HISTORY_READ_ONLY")
	_, err = f.s.Delete(ctx, f.p, false, got.Checkin.ID, 1)
	code(t, err, "HISTORY_READ_ONLY")
}

// TestTaskConfigurationAndBackfill preserves historical snapshots while enforcing current rules.
func TestTaskConfigurationAndBackfill(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 2)
	in := CreateInput{TaskID: task.ID, BusinessDate: "2026-10-28", ExpectedTaskVersion: 1, Text: "补录"}
	got, err := f.s.Create(ctx, f.p, true, "backfill", in)
	if err != nil {
		t.Fatal(err)
	}
	if got.Checkin.Source != "backfill" || got.Checkin.BusinessDate != "2026-10-28" {
		t.Fatalf("%+v", got)
	}
	input := taskInput(1)
	input.CoinReward = 50
	input.ExpectedVersion = 1
	if _, err = f.s.UpdateTask(ctx, f.p, task.ID, input); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Create(ctx, f.p, true, "stale-task", in)
	code(t, err, "TASK_CHANGED")
	in.ExpectedTaskVersion = 2
	in.BusinessDate = "2026-10-31"
	_, err = f.s.Create(ctx, f.p, true, "future", in)
	code(t, err, "FUTURE_DATE")
	input.ExpectedVersion = 2
	input.Enabled = false
	if _, err = f.s.UpdateTask(ctx, f.p, task.ID, input); err != nil {
		t.Fatal(err)
	}
	in.ExpectedTaskVersion = 3
	in.BusinessDate = "2026-10-27"
	_, err = f.s.Create(ctx, f.p, true, "disabled", in)
	code(t, err, "TASK_UNAVAILABLE")
	if _, err = f.s.Edit(ctx, f.p, true, got.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "历史内容"}); err != nil {
		t.Fatal(err)
	}
	assertLedger(t, f.s.DB)
}

// TestCategoryDeletion distinguishes disabled members from soft-deleted members.
func TestCategoryDeletion(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	category, err := f.s.CreateCategory(ctx, f.p, "category", CategoryInput{Name: "学习"})
	if err != nil {
		t.Fatal(err)
	}
	in := taskInput(1)
	in.CategoryID = &category.ID
	in.Enabled = false
	task, err := f.s.CreateTask(ctx, f.p, "categorized-task", in)
	if err != nil {
		t.Fatal(err)
	}
	code(t, f.s.DeleteCategory(ctx, f.p, category.ID, 1), "CATEGORY_NOT_EMPTY")
	if err = f.s.DeleteTask(ctx, f.p, task.ID, 1); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteCategory(ctx, f.p, category.ID, 1); err != nil {
		t.Fatal(err)
	}
}

// TestIndependentConnectionsCompeteForLastAllowance starts two writers behind an actual file lock.
func TestIndependentConnectionsCompeteForLastAllowance(t *testing.T) {
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
	gate, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for index, s := range []*Service{f.s, other} {
		go func(index int, s *Service) {
			ready.Done()
			<-start
			_, err := s.Create(ctx, f.p, false, []string{"one", "two"}[index], CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
			results <- err
		}(index, s)
	}
	ready.Wait()
	close(start)
	time.Sleep(20 * time.Millisecond)
	if err := gate.Commit(); err != nil {
		t.Fatal(err)
	}
	success := 0
	for range 2 {
		if err := <-results; err == nil {
			success++
		} else {
			code(t, err, "DAILY_LIMIT_REACHED")
		}
	}
	if success != 1 {
		t.Fatalf("success=%d", success)
	}
	var count int
	if err := f.s.DB.QueryRow("SELECT count(*) FROM checkins WHERE deleted_at IS NULL").Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d %v", count, err)
	}
	assertLedger(t, f.s.DB)
}

// assertLedger checks both stored balances against immutable economic facts.
func assertLedger(t *testing.T, db *sql.DB) {
	t.Helper()
	var coins, diamonds, sumCoins, sumDiamonds int64
	if err := db.QueryRow("SELECT coins,diamonds,(SELECT coalesce(sum(coin_delta),0) FROM wallet_entries),(SELECT coalesce(sum(diamond_delta),0) FROM wallet_entries) FROM wallets WHERE account_id=1").Scan(&coins, &diamonds, &sumCoins, &sumDiamonds); err != nil {
		t.Fatal(err)
	}
	if coins != sumCoins || diamonds != sumDiamonds {
		t.Fatalf("wallet=(%d,%d) ledger=(%d,%d)", coins, diamonds, sumCoins, sumDiamonds)
	}
}
