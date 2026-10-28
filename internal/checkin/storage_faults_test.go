package checkin_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/httpapi"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
	"github.com/wookiisky/check-in-suite/internal/media"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/internal/wallet"
	"github.com/wookiisky/check-in-suite/migrations"
)

// faultApplication contains one real account, file database and actual HTTP business routes.
type faultApplication struct {
	db        *sql.DB           // Database on the selected test volume.
	app       *httpapi.App      // Actual request decoder, error mapping and feature routes.
	checkins  *checkin.Service  // Record service sharing the application database.
	media     *media.Service    // Private-file service on the same selected volume.
	principal account.Principal // Session used by upload operations.
	cookie    *http.Cookie      // Browser authentication cookie.
	csrf      string            // Session-bound mutation token.
	taskID    string            // Eligible task with a high allowance.
}

// newFaultApplication initializes only the caller's temporary directory, with no production data.
func newFaultApplication(t *testing.T, directory string) faultApplication {
	t.Helper()
	ctx := context.Background()
	cfg := config.Defaults()
	cfg.DatabasePath = filepath.Join(directory, "island.db")
	cfg.MediaDirectory = filepath.Join(directory, "media")
	cfg.TempDirectory = filepath.Join(directory, "tmp")
	cfg.PublicOrigin = "https://fault-test.example"
	for _, path := range []string{cfg.MediaDirectory, cfg.TempDirectory} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	db, err := storage.Open(ctx, cfg.DatabasePath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	clock := func() time.Time { return time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC) }
	accounts := account.New(db, cfg)
	accounts.Now = clock
	if err := accounts.Initialize(ctx, "fault-test", "故障验证", "login-password", "management-password"); err != nil {
		t.Fatal(err)
	}
	token, session, err := accounts.Login(ctx, "fault-test", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = accounts.Unlock(ctx, p, "management-password"); err != nil {
		t.Fatal(err)
	}
	records := checkin.New(db, accounts, cfg)
	records.Now = clock
	task, err := records.CreateTask(ctx, p, "fault-task", checkin.TaskInput{Name: "故障验证任务", IconKey: "book-v1", CoinReward: 10, DiamondReward: 2, DailyLimit: 1000, Weekdays: []int{1, 2, 3, 4, 5, 6, 7}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	files := media.New(db, accounts, cfg)
	files.Now = clock
	app := httpapi.NewApplication(&httpapi.Readiness{DB: db}, cfg, accounts)
	app.RegisterCheckins(records)
	return faultApplication{db, app, records, files, p, &http.Cookie{Name: "island_session", Value: token}, session.CSRFToken, task.ID}
}

// command sends real JSON through authorization, a SQLite transaction and HTTP error translation.
func (f faultApplication) command(t *testing.T, key string) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(checkin.CreateInput{TaskID: f.taskID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", Text: strings.Repeat("字", 1800)})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/v1/checkins", bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", f.app.Config.PublicOrigin)
	r.Header.Set("X-CSRF-Token", f.csrf)
	r.Header.Set("Idempotency-Key", key)
	r.AddCookie(f.cookie)
	w := httptest.NewRecorder()
	f.app.ServeHTTP(w, r)
	return w
}

// assertFaultFacts checks all economic facts together after the failed transaction releases its lock.
func (f faultApplication) assertFaultFacts(t *testing.T, want int64) {
	t.Helper()
	var records, entries, receipts, coins, diamonds int64
	err := f.db.QueryRow(`SELECT (SELECT count(*) FROM checkins),(SELECT count(*) FROM wallet_entries),(SELECT count(*) FROM idempotency_requests WHERE operation='checkin.create'),coins,diamonds FROM wallets WHERE account_id=1`).Scan(&records, &entries, &receipts, &coins, &diamonds)
	if err != nil {
		t.Fatal(err)
	}
	if records != want || entries != want || receipts != want || coins != want*10 || diamonds != want*2 {
		t.Fatalf("partial facts: records=%d entries=%d receipts=%d coins=%d diamonds=%d want=%d", records, entries, receipts, coins, diamonds, want)
	}
	var integrity string
	if err := f.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity=%s error=%v", integrity, err)
	}
}

// TestSQLitePageLimitRollsBackCheckin exercises actual SQLITE_FULL, not a simulated error or filesystem quota.
func TestSQLitePageLimitRollsBackCheckin(t *testing.T) {
	f := newFaultApplication(t, t.TempDir())
	var pages int64
	if err := f.db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatal(err)
	}
	var maximum int64
	if err := f.db.QueryRow(fmt.Sprintf("PRAGMA max_page_count=%d", pages)).Scan(&maximum); err != nil || maximum != pages {
		t.Fatalf("limit=%d pages=%d error=%v", maximum, pages, err)
	}
	var committed int64
	failedKey := ""
	for attempt := 0; attempt < 30; attempt++ {
		key := fmt.Sprintf("full-%d", attempt)
		result := f.command(t, key)
		if result.Code == 201 {
			committed++
			continue
		}
		if result.Code != 503 || !strings.Contains(result.Body.String(), `"code":"STORAGE_UNAVAILABLE"`) {
			t.Fatalf("full response: %d %s", result.Code, result.Body)
		}
		failedKey = key
		break
	}
	if failedKey == "" {
		t.Fatal("page limit did not produce SQLITE_FULL")
	}
	f.assertFaultFacts(t, committed)
	if _, err := f.db.Exec("PRAGMA max_page_count=1073741823"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		retried := f.command(t, failedKey)
		if retried.Code != 201 {
			t.Fatalf("retry: %d %s", retried.Code, retried.Body)
		}
	}
	f.assertFaultFacts(t, committed+1)
	t.Logf("实际SQLite页上限=%d；失败前成功%d条；失败无部分事实；放宽后原键重试与重放仅新增一条", maximum, committed)
}

// constrainedDirectory refuses ordinary host storage and returns a private directory on the disposable volume.
func constrainedDirectory(t *testing.T) (string, uint64) {
	t.Helper()
	mount := os.Getenv("ISLAND_FAULT_MOUNT")
	if mount == "" {
		t.Skip("仅由scripts/verify-storage-faults.py在临时受限卷运行；普通测试不声明ENOSPC验证")
	}
	if _, err := os.Stat(filepath.Join(mount, ".island-storage-fault-volume")); err != nil {
		t.Fatal("missing disposable-volume marker")
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(mount, &filesystem); err != nil {
		t.Fatal(err)
	}
	capacity := uint64(filesystem.Blocks) * uint64(filesystem.Bsize)
	if capacity > 128*1024*1024 {
		t.Fatalf("refusing to fill a volume larger than 128 MiB: %d", capacity)
	}
	directory, err := os.MkdirTemp(mount, "application-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return directory, capacity
}

// fillVolume consumes actual blocks until the small disposable filesystem reports ENOSPC.
func fillVolume(t *testing.T, directory string, capacity uint64) *os.File {
	t.Helper()
	filler, err := os.Create(filepath.Join(directory, "capacity-fill.bin"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { filler.Close(); os.Remove(filler.Name()) })
	chunk := make([]byte, 32*1024)
	var filled int64
	exhausted := false
	for filled < int64(capacity)+int64(len(chunk)) {
		n, writeErr := filler.Write(chunk)
		filled += int64(n)
		if writeErr != nil {
			if !errors.Is(writeErr, syscall.ENOSPC) {
				t.Fatalf("unexpected fill error: %v", writeErr)
			}
			t.Logf("实际ENOSPC：受限卷容量=%d，填充字节=%d，错误=%v", capacity, filled, writeErr)
			exhausted = true
			break
		}
	}
	if !exhausted {
		t.Fatal("bounded volume did not report ENOSPC")
	}
	// Consume any final sub-chunk blocks, so a small SQLite WAL header cannot fit by accident.
	for range 128 {
		if _, err := filler.Write(make([]byte, 512)); err != nil {
			if !errors.Is(err, syscall.ENOSPC) {
				t.Fatal(err)
			}
			break
		}
	}
	if err := filler.Sync(); err != nil && !errors.Is(err, syscall.ENOSPC) {
		t.Fatal(err)
	}
	return filler
}

// TestConstrainedFilesystemFull runs only on the disposable small volume created by the verification script.
func TestConstrainedFilesystemFull(t *testing.T) {
	directory, capacity := constrainedDirectory(t)
	f := newFaultApplication(t, directory)
	if _, err := f.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	filler := fillVolume(t, directory, capacity)
	failed := f.command(t, "filesystem-full")
	if failed.Code != 503 || !strings.Contains(failed.Body.String(), `"code":"STORAGE_UNAVAILABLE"`) {
		t.Fatalf("disk-full checkin: %d %s", failed.Code, failed.Body)
	}
	var photo bytes.Buffer
	if err := png.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	upload, uploadErr := f.media.Upload(context.Background(), f.principal, "photo", bytes.NewReader(photo.Bytes()))
	if uploadErr == nil {
		t.Fatalf("disk-full upload incorrectly succeeded: %+v", upload)
	}
	var domain *core.Error
	if !errors.As(uploadErr, &domain) || domain.Code != "STORAGE_UNAVAILABLE" {
		t.Fatalf("upload error=%v", uploadErr)
	}
	if err := filler.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filler.Name()); err != nil {
		t.Fatal(err)
	}
	f.assertFaultFacts(t, 0)
	var registered int
	if err := f.db.QueryRow("SELECT count(*) FROM media_files WHERE state IN ('ready','attached')").Scan(&registered); err != nil || registered != 0 {
		t.Fatalf("failed upload readable registration=%d error=%v", registered, err)
	}
	for i := 0; i < 2; i++ {
		result := f.command(t, "filesystem-full")
		if result.Code != 201 {
			t.Fatalf("recovered checkin: %d %s", result.Code, result.Body)
		}
	}
	f.assertFaultFacts(t, 1)
	upload, err := f.media.Upload(context.Background(), f.principal, "photo", bytes.NewReader(photo.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	_, file, err := f.media.Open(context.Background(), f.principal, upload.ID)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	t.Logf("释放填充文件后：原打卡键恢复且仅一次发奖；媒体重新上传并鉴权读取成功；无失败上传可读引用")
}

// TestConstrainedFilesystemCommitFailure fills the volume only after every transaction statement succeeds.
func TestConstrainedFilesystemCommitFailure(t *testing.T) {
	directory, capacity := constrainedDirectory(t)
	f := newFaultApplication(t, directory)
	ctx := context.Background()
	if _, err := f.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	now := f.checkins.Now()
	if err := account.Authorize(ctx, tx, f.principal, false, now); err != nil {
		t.Fatal(err)
	}
	id := core.ID()
	input := checkin.CreateInput{TaskID: f.taskID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", Text: strings.Repeat("字", 1800)}
	_, err = tx.ExecContext(ctx, `INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,text,source,created_at,updated_at) VALUES(?,?,'2026-10-29','故障验证任务','book-v1',10,2,?,'today',?,?)`, id, f.taskID, input.Text, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	balance, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.CheckinGrant, ResourceID: id, Coins: 10, Diamonds: 2, At: now})
	if err != nil {
		t.Fatal(err)
	}
	hash, err := idempotency.Hash("checkin.create", input)
	if err != nil {
		t.Fatal(err)
	}
	receipt := map[string]any{"checkin_id": id, "wallet": balance, "task_remaining": 999, "today": "2026-10-29"}
	if err := idempotency.Save(ctx, tx, "checkin.create", "commit-full", hash, id, 201, receipt, now); err != nil {
		t.Fatal(err)
	}
	t.Log("记录、钱包、流水与幂等收据SQL全部成功；现在填满卷再调用Commit")
	filler := fillVolume(t, directory, capacity)
	commitErr := tx.Commit()
	if commitErr == nil {
		t.Fatal("commit unexpectedly succeeded on full filesystem")
	}
	var sqliteError interface{ Code() int }
	if !errors.As(commitErr, &sqliteError) || sqliteError.Code()&255 != 13 {
		t.Fatalf("unexpected commit failure: %v", commitErr)
	}
	t.Logf("实际Commit失败：%v", commitErr)
	if err := filler.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filler.Name()); err != nil {
		t.Fatal(err)
	}
	f.assertFaultFacts(t, 0)
	for range 2 {
		result := f.command(t, "commit-full")
		if result.Code != 201 {
			t.Fatalf("retry after failed commit: %d %s", result.Code, result.Body)
		}
	}
	f.assertFaultFacts(t, 1)
	t.Log("失败提交四类事实全部回滚；释放空间后原键只产生一条记录和一笔奖励")
}
