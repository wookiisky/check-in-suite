package checkin

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/achievement"
)

// achievementService uses the same database and business clock as real check-in writes.
func achievementService(f fixture) *achievement.Service {
	s := achievement.New(f.s.DB, f.s.Accounts, f.s.Config)
	s.Now = f.s.Now
	return s
}

// achievementInput provides a small count rule with a real permanent badge.
func achievementInput() achievement.Input {
	return achievement.Input{Name: "阅读起步", AssetKey: "badge-sprout-v1", Metric: "count", Scope: "all", TaskIDs: []string{}, Target: 2, Enabled: true}
}

// TestAchievementDeletionReconcilesQualificationAndEquipment exercises the real mutation boundary.
func TestAchievementDeletionReconcilesQualificationAndEquipment(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 3)
	badge, err := s.Create(ctx, f.p, "badge", achievementInput())
	if err != nil {
		t.Fatal(err)
	}
	in := CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}
	first, err := f.s.Create(ctx, f.p, false, "first", in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.Create(ctx, f.p, false, "second", in)
	if err != nil {
		t.Fatal(err)
	}
	equipped, err := s.SetEquipped(ctx, f.p, badge.ID, true)
	if err != nil || !equipped.Qualified || !equipped.Equipped {
		t.Fatalf("%+v %v", equipped, err)
	}
	if _, err = f.s.Create(ctx, f.p, false, "second", in); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, second.Checkin.ID, 1); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Qualified || list.Items[0].Equipped || list.Items[0].Progress != 1 {
		t.Fatalf("%+v", list)
	}
	if _, err = s.SetEquipped(ctx, f.p, badge.ID, true); err == nil {
		t.Fatal("unearned badge equipped")
	}
	if _, err = f.s.Create(ctx, f.p, false, "third", in); err != nil {
		t.Fatal(err)
	}
	list, err = s.List(ctx, f.p, false)
	if err != nil || !list.Items[0].Qualified || list.Items[0].Equipped {
		t.Fatalf("%+v %v", list, err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, first.Checkin.ID, 1); err != nil {
		t.Fatal(err)
	}
}

// TestAchievementDeletedTaskKeepsCategoryContribution ensures later recalculation retains deleted tasks.
func TestAchievementDeletedTaskKeepsCategoryContribution(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	category, err := f.s.CreateCategory(ctx, f.p, "category", CategoryInput{Name: "学习"})
	if err != nil {
		t.Fatal(err)
	}
	ti := taskInput(2)
	ti.CategoryID = &category.ID
	task, err := f.s.CreateTask(ctx, f.p, "task", ti)
	if err != nil {
		t.Fatal(err)
	}
	ai := achievementInput()
	ai.Scope = "category"
	ai.CategoryID = &category.ID
	ai.Target = 1
	badge, err := s.Create(ctx, f.p, "badge", ai)
	if err != nil {
		t.Fatal(err)
	}
	record, err := f.s.Create(ctx, f.p, false, "record", CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetEquipped(ctx, f.p, badge.ID, true); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteTask(ctx, f.p, task.ID, 1); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteCategory(ctx, f.p, category.ID, 1); err != nil {
		t.Fatal(err)
	}
	camp, err := f.s.Camp(ctx, f.p, "")
	if err != nil || len(camp.Achievements) != 1 {
		t.Fatalf("%+v %v", camp, err)
	}
	if _, err = s.Update(ctx, f.p, badge.ID, achievement.UpdateInput{Input: ai, ExpectedVersion: 1}); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || !list.Items[0].Qualified || list.Items[0].Progress != 1 {
		t.Fatalf("%+v %v", list, err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, record.Checkin.ID, 1); err != nil {
		t.Fatal(err)
	}
	camp, err = f.s.Camp(ctx, f.p, "")
	if err != nil || len(camp.Achievements) != 0 {
		t.Fatalf("%+v %v", camp, err)
	}
}

// TestAchievementFailureRollsBackCheckinWalletAndReceipt proves achievements share the real transaction.
func TestAchievementFailureRollsBackCheckinWalletAndReceipt(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 2)
	ai := achievementInput()
	ai.Target = 1
	if _, err := s.Create(ctx, f.p, "badge", ai); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Exec(`CREATE TRIGGER fail_achievement BEFORE UPDATE ON achievements BEGIN SELECT RAISE(ABORT,'test failure'); END;`); err != nil {
		t.Fatal(err)
	}
	in := CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1}
	if _, err := f.s.Create(ctx, f.p, false, "attempt", in); err == nil {
		t.Fatal("injected failure succeeded")
	}
	var records, coins, receipts int
	if err := f.s.DB.QueryRow(`SELECT (SELECT count(*) FROM checkins),(SELECT coins FROM wallets),(SELECT count(*) FROM idempotency_requests WHERE operation='checkin.create')`).Scan(&records, &coins, &receipts); err != nil {
		t.Fatal(err)
	}
	if records != 0 || coins != 0 || receipts != 0 {
		t.Fatalf("records=%d coins=%d receipts=%d", records, coins, receipts)
	}
	if _, err := f.s.DB.Exec(`DROP TRIGGER fail_achievement`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Create(ctx, f.p, false, "attempt", in); err != nil {
		t.Fatal(err)
	}
}
