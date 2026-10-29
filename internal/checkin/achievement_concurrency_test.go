package checkin

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestAchievementConcurrentCheckinsReconcileCommittedFacts serializes real competing SQLite writers.
func TestAchievementConcurrentCheckinsReconcileCommittedFacts(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 2)
	badge, err := s.Create(ctx, f.p, "badge", achievementInput())
	if err != nil {
		t.Fatal(err)
	}
	otherDB, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer otherDB.Close()
	other := New(otherDB, account.New(otherDB, f.s.Config), f.s.Config)
	other.Now = f.s.Now
	gate, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for index, service := range []*Service{f.s, other} {
		go func(index int, service *Service) {
			ready.Done()
			<-start
			_, err := service.Create(ctx, f.p, false, []string{"first", "second"}[index], CreateInput{TaskID: task.ID, ExpectedToday: "2026-10-29", ExpectedTaskVersion: 1})
			results <- err
		}(index, service)
	}
	ready.Wait()
	close(start)
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = <-results; err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || len(list.Items) != 1 || list.Items[0].ID != badge.ID || !list.Items[0].Qualified || list.Items[0].Progress != 2 {
		t.Fatalf("%+v %v", list, err)
	}
	assertLedger(t, f.s.DB)
}

// TestAchievementEquipmentCannotSurviveConcurrentRevocation proves the invariant across separate connections.
func TestAchievementEquipmentCannotSurviveConcurrentRevocation(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 1)
	record := achievementRecord(t, f, task, "record", "2026-10-29")
	ai := achievementInput()
	ai.Target = 1
	badge, err := s.Create(ctx, f.p, "badge", ai)
	if err != nil {
		t.Fatal(err)
	}
	otherDB, err := storage.Open(ctx, f.path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer otherDB.Close()
	other := achievement.New(otherDB, account.New(otherDB, f.s.Config), f.s.Config)
	other.Now = f.s.Now
	gate, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	deletion := make(chan error, 1)
	equipment := make(chan error, 1)
	var ready sync.WaitGroup
	ready.Add(2)
	go func() { ready.Done(); <-start; _, err := f.s.Delete(ctx, f.p, false, record.ID, 1); deletion <- err }()
	go func() { ready.Done(); <-start; _, err := other.SetEquipped(ctx, f.p, badge.ID, true); equipment <- err }()
	ready.Wait()
	close(start)
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-deletion; err != nil {
		t.Fatal(err)
	}
	if err = <-equipment; err != nil {
		code(t, err, "ACHIEVEMENT_NOT_EARNED")
	}
	list, err := s.List(ctx, f.p, false)
	if err != nil || list.Items[0].Qualified || list.Items[0].Equipped || list.Items[0].Progress != 0 {
		t.Fatalf("%+v %v", list, err)
	}
}

// TestAchievementDeletionFailureKeepsRecordWalletAndEquipment prevents partial revocation.
func TestAchievementDeletionFailureKeepsRecordWalletAndEquipment(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	s := achievementService(f)
	task := createTask(t, f, 1)
	record := achievementRecord(t, f, task, "record", "2026-10-29")
	ai := achievementInput()
	ai.Target = 1
	badge, err := s.Create(ctx, f.p, "badge", ai)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetEquipped(ctx, f.p, badge.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Exec(`CREATE TRIGGER fail_revoke BEFORE UPDATE ON achievements BEGIN SELECT RAISE(ABORT,'test failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Delete(ctx, f.p, false, record.ID, 1); err == nil {
		t.Fatal("revocation unexpectedly committed")
	}
	camp, err := f.s.Camp(ctx, f.p, "")
	if err != nil || camp.Wallet.Coins != 10 || len(camp.Achievements) != 1 {
		t.Fatalf("%+v %v", camp, err)
	}
	var deleted bool
	if err = f.s.DB.QueryRow("SELECT deleted_at IS NOT NULL FROM checkins WHERE id=?", record.ID).Scan(&deleted); err != nil || deleted {
		t.Fatalf("deleted=%v %v", deleted, err)
	}
	assertLedger(t, f.s.DB)
}
