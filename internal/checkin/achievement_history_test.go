package checkin

import (
	"context"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/achievement"
)

// setAchievementDay advances only the test business clock, keeping sessions inside their validity range.
func setAchievementDay(f fixture, s *achievement.Service, date string) {
	day, _ := time.Parse(time.DateOnly, date)
	f.s.Now = func() time.Time { return day.Add(4 * time.Hour) }
	s.Now = f.s.Now
}

// achievementRecord creates a historical fact through the existing backfill contract.
func achievementRecord(t *testing.T, f fixture, task Task, key, date string) Record {
	t.Helper()
	value, err := f.s.Create(context.Background(), f.p, true, key, CreateInput{TaskID: task.ID, ExpectedTaskVersion: task.Version, BusinessDate: date})
	if err != nil {
		t.Fatal(err)
	}
	return value.Checkin
}

// TestAchievementScheduleChangesKeepEarlierConsecutiveMondays tests real schedule versions.
func TestAchievementScheduleChangesKeepEarlierConsecutiveMondays(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	setAchievementDay(f, s, "2026-10-01")
	ti := taskInput(2)
	ti.Weekdays = []int{1}
	task, err := f.s.CreateTask(ctx, f.p, "weekly-task", ti)
	if err != nil {
		t.Fatal(err)
	}
	setAchievementDay(f, s, "2026-10-19")
	achievementRecord(t, f, task, "week1", "2026-10-05")
	second := achievementRecord(t, f, task, "week2", "2026-10-12")
	achievementRecord(t, f, task, "week3", "2026-10-19")
	ai := achievementInput()
	ai.Metric = "streak"
	ai.Target = 3
	badge, err := s.Create(ctx, f.p, "streak", ai)
	if err != nil || !badge.Qualified || badge.Progress != 3 {
		t.Fatalf("%+v %v", badge, err)
	}
	setAchievementDay(f, s, "2026-10-20")
	ti.Weekdays = []int{1, 2, 3, 4, 5, 6, 7}
	ti.ExpectedVersion = task.Version
	task, err = f.s.UpdateTask(ctx, f.p, task.ID, ti)
	if err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || list.Items[0].Progress != 3 {
		t.Fatalf("%+v %v", list, err)
	}
	achievementRecord(t, f, task, "daily1", "2026-10-20")
	setAchievementDay(f, s, "2026-10-21")
	achievementRecord(t, f, task, "daily2", "2026-10-21")
	ai.Target = 5
	badge, err = s.Update(ctx, f.p, badge.ID, achievement.UpdateInput{Input: ai, ExpectedVersion: badge.Version})
	if err != nil || badge.Progress != 5 || !badge.Qualified {
		t.Fatalf("%+v %v", badge, err)
	}
	if _, err = s.SetEquipped(ctx, f.p, badge.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Delete(ctx, f.p, true, second.ID, 1); err != nil {
		t.Fatal(err)
	}
	list, err = s.List(ctx, f.p, false)
	if err != nil || list.Items[0].Progress != 3 || list.Items[0].Qualified || list.Items[0].Equipped {
		t.Fatalf("%+v %v", list, err)
	}
}

// TestAchievementWindowRechecksAllHistoricalWindows keeps a surviving alternative interval.
func TestAchievementWindowRechecksAllHistoricalWindows(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 4)
	first := achievementRecord(t, f, task, "old1", "2026-10-01")
	achievementRecord(t, f, task, "old2", "2026-10-02")
	achievementRecord(t, f, task, "recent1", "2026-10-20")
	recent := achievementRecord(t, f, task, "recent2", "2026-10-21")
	window := 2
	ai := achievementInput()
	ai.WindowDays = &window
	badge, err := s.Create(ctx, f.p, "window", ai)
	if err != nil || !badge.Qualified || badge.Progress != 2 {
		t.Fatalf("%+v %v", badge, err)
	}
	if _, err = f.s.Delete(ctx, f.p, true, first.ID, 1); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || !list.Items[0].Qualified {
		t.Fatalf("%+v %v", list, err)
	}
	if _, err = f.s.Delete(ctx, f.p, true, recent.ID, 1); err != nil {
		t.Fatal(err)
	}
	list, err = s.List(ctx, f.p, false)
	if err != nil || list.Items[0].Qualified || list.Items[0].Progress != 1 {
		t.Fatalf("%+v %v", list, err)
	}
}

// TestAchievementCategoryMoveTransfersCurrentMembershipAndHistoricalRewards uses original reward snapshots.
func TestAchievementCategoryMoveTransfersCurrentMembershipAndHistoricalRewards(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	source, err := f.s.CreateCategory(ctx, f.p, "source", CategoryInput{Name: "学习"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := f.s.CreateCategory(ctx, f.p, "target", CategoryInput{Name: "成长"})
	if err != nil {
		t.Fatal(err)
	}
	ti := taskInput(3)
	ti.CategoryID = &source.ID
	task, err := f.s.CreateTask(ctx, f.p, "task", ti)
	if err != nil {
		t.Fatal(err)
	}
	achievementRecord(t, f, task, "record", "2026-10-29")
	ai := achievementInput()
	ai.Scope = "category"
	ai.CategoryID = &source.ID
	ai.Metric = "coins"
	ai.Target = 10
	old, err := s.Create(ctx, f.p, "old", ai)
	if err != nil || !old.Qualified {
		t.Fatalf("%+v %v", old, err)
	}
	ai.CategoryID = &target.ID
	next, err := s.Create(ctx, f.p, "new", ai)
	if err != nil || next.Qualified {
		t.Fatalf("%+v %v", next, err)
	}
	ti.CategoryID = &target.ID
	ti.CoinReward = 100
	ti.ExpectedVersion = task.Version
	if _, err = f.s.UpdateTask(ctx, f.p, task.ID, ti); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.ID == old.ID && (item.Qualified || item.Progress != 0) {
			t.Fatalf("old=%+v", item)
		}
		if item.ID == next.ID && (!item.Qualified || item.Progress != 10) {
			t.Fatalf("new=%+v", item)
		}
	}
}

// TestAchievementArchiveRetainsOwnershipButDeletionStillRevokes confirms archived rules remain auditable.
func TestAchievementArchiveRetainsOwnershipButDeletionStillRevokes(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 3)
	record := achievementRecord(t, f, task, "record", "2026-10-29")
	ai := achievementInput()
	ai.Target = 1
	badge, err := s.Create(ctx, f.p, "badge", ai)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, f.p, badge.ID, badge.Version); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetEquipped(ctx, f.p, badge.ID, true); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || len(list.Items) != 1 || !list.Items[0].Deleted {
		t.Fatalf("%+v %v", list, err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, record.ID, 1); err != nil {
		t.Fatal(err)
	}
	achievementRecord(t, f, task, "replacement", "2026-10-29")
	list, err = s.List(ctx, f.p, false)
	if err != nil || len(list.Items) != 0 {
		t.Fatalf("%+v %v", list, err)
	}
}
