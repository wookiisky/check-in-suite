package checkin

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestCalendarAndStatistics preserve date attribution, bounded previews and stable task grouping.
func TestCalendarAndStatistics(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 10)
	var first Record
	for i, date := range []string{"2026-10-01", "2026-10-28", "2026-10-28", "2026-10-28", "2026-10-28", "2026-10-29"} {
		result, err := f.s.Create(ctx, f.p, true, core.ID(), CreateInput{TaskID: task.ID, BusinessDate: date, ExpectedTaskVersion: 1})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = result.Checkin
		}
	}
	updated := taskInput(10)
	updated.Name = "新任务名"
	updated.ExpectedVersion = 1
	if _, err := f.s.UpdateTask(ctx, f.p, task.ID, updated); err != nil {
		t.Fatal(err)
	}
	stats, err := f.s.Stats(ctx, f.p, "2026-10-01", "2026-10-29")
	if err != nil || stats.TotalCount != 6 || stats.ActiveDays != 3 || len(stats.Items) != 1 || stats.Items[0].TaskID != task.ID || stats.Items[0].Name != updated.Name {
		t.Fatalf("statistics: %+v %v", stats, err)
	}
	calendar, err := f.s.Calendar(ctx, f.p, "2026-10")
	if err != nil || len(calendar.Days) != 31 {
		t.Fatalf("month: %+v %v", calendar, err)
	}
	day := calendar.Days[27]
	if day.Date != "2026-10-28" || day.Count != 4 || len(day.Icons) != 3 || day.MoreCount != 1 {
		t.Fatalf("bounded preview: %+v", day)
	}
	if calendar.Days[30].Count != 0 || len(calendar.Days[30].Icons) != 0 {
		t.Fatalf("future date must remain empty: %+v", calendar.Days[30])
	}
	if err := f.s.DeleteTask(ctx, f.p, task.ID, 2); err != nil {
		t.Fatal(err)
	}
	stats, err = f.s.Stats(ctx, f.p, "2026-10-01", "2026-10-29")
	if err != nil || stats.TotalCount != 6 || len(stats.Items) != 1 {
		t.Fatalf("deleted task lost history: %+v %v", stats, err)
	}
	if _, err := f.s.Delete(ctx, f.p, true, first.ID, 1); err != nil {
		t.Fatal(err)
	}
	stats, err = f.s.Stats(ctx, f.p, "2026-10-01", "2026-10-29")
	if err != nil || stats.TotalCount != 5 || stats.ActiveDays != 2 {
		t.Fatalf("deleted record still counted: %+v %v", stats, err)
	}
	calendar, err = f.s.Calendar(ctx, f.p, "2026-10")
	if err != nil || calendar.Days[0].Count != 0 {
		t.Fatalf("deleted record remains in calendar: %+v %v", calendar, err)
	}
}

// TestStatisticsKeepDistinctTaskIdentities groups equal names separately and orders by count with stable ties.
func TestStatisticsKeepDistinctTaskIdentities(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	first := createTask(t, f, 10)
	second, err := f.s.CreateTask(ctx, f.p, "another-task", taskInput(10))
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []Task{first, second} {
		if _, err := f.s.Create(ctx, f.p, false, core.ID(), CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := f.s.Stats(ctx, f.p, "2026-10-29", "2026-10-29")
	if err != nil || stats.TotalCount != 2 || len(stats.Items) != 2 || stats.Items[0].TaskID >= stats.Items[1].TaskID {
		t.Fatalf("equal-name grouping or tie order: %+v %v", stats, err)
	}
	if _, err := f.s.Create(ctx, f.p, false, core.ID(), CreateInput{TaskID: second.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}); err != nil {
		t.Fatal(err)
	}
	stats, err = f.s.Stats(ctx, f.p, "2026-10-29", "2026-10-29")
	if err != nil || stats.Items[0].TaskID != second.ID || stats.Items[0].Count != 2 {
		t.Fatalf("descending count order: %+v %v", stats, err)
	}
}

// TestReportRanges checks inclusive day limits, actual dates and an empty month without demo records.
func TestReportRanges(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	for _, dates := range [][2]string{{"2026-10-29", "2026-10-28"}, {"2026-01-01", "2026-10-30"}, {"2025-10-28", "2026-10-29"}, {"2026-02-30", "2026-03-01"}} {
		_, err := f.s.Stats(ctx, f.p, dates[0], dates[1])
		code(t, err, "INVALID_DATE_RANGE")
	}
	stats, err := f.s.Stats(ctx, f.p, "2025-10-29", "2026-10-29")
	if err != nil || stats.TotalCount != 0 || stats.Items == nil {
		t.Fatalf("inclusive 366-day range: %+v %v", stats, err)
	}
	for _, month := range []string{"", "2026-2", "2026-13", "2026-10-01"} {
		_, err := f.s.Calendar(ctx, f.p, month)
		code(t, err, "INVALID_DATE_RANGE")
	}
	calendar, err := f.s.Calendar(ctx, f.p, "2028-02")
	if err != nil || len(calendar.Days) != 29 || calendar.Days[28].Count != 0 {
		t.Fatalf("leap month: %+v %v", calendar, err)
	}
	if err := f.s.Accounts.Logout(ctx, f.p); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Calendar(ctx, f.p, "2026-10")
	code(t, err, "SESSION_REQUIRED")
}

// TestStatisticsUseOneSnapshot commits a competing write after the reader has acquired its real snapshot.
func TestStatisticsUseOneSnapshot(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	task := createTask(t, f, 10)
	reader, err := f.s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback()
	if err := account.Authorize(ctx, reader, f.p, false, f.s.Now()); err != nil {
		t.Fatal(err)
	}
	other, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	writer := New(other, account.New(other, f.s.Config), f.s.Config)
	writer.Now = f.s.Now
	if _, err := writer.Create(ctx, f.p, false, "snapshot-writer", CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}); err != nil {
		t.Fatal(err)
	}
	old, err := readStatistics(ctx, reader, "2026-10-01", "2026-10-29")
	if err != nil || old.TotalCount != 0 || old.ActiveDays != 0 || len(old.Items) != 0 {
		t.Fatalf("mixed snapshot: %+v %v", old, err)
	}
	if err := reader.Commit(); err != nil {
		t.Fatal(err)
	}
	latest, err := f.s.Stats(ctx, f.p, "2026-10-01", "2026-10-29")
	if err != nil || latest.TotalCount != 1 || latest.ActiveDays != 1 || len(latest.Items) != 1 {
		t.Fatalf("next read missed committed data: %+v %v", latest, err)
	}
}
