package checkin

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
)

// addAccount authenticates another real account against the fixture's SQLite file.
func addAccount(t *testing.T, f fixture, username string) account.Principal {
	t.Helper()
	ctx := context.Background()
	if err := f.s.Accounts.Initialize(ctx, username, username, "login password", "manage password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.s.Accounts.Login(ctx, username, "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.s.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Accounts.Unlock(ctx, p, "manage password"); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestAccountTasksRecordsAndAchievementsStayIndependent covers private state through actual mutations.
func TestAccountTasksRecordsAndAchievementsStayIndependent(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	other := addAccount(t, f, "second")
	firstTask := createTask(t, f, 1)
	category, err := f.s.CreateCategory(ctx, f.p, "category", CategoryInput{Name: "学习"})
	if err != nil {
		t.Fatal(err)
	}
	secondCategory, err := f.s.CreateCategory(ctx, other, "category", CategoryInput{Name: "运动"})
	if err != nil || secondCategory.ID == category.ID {
		t.Fatalf("category=%+v err=%v", secondCategory, err)
	}
	categories, err := f.s.Categories(ctx, other)
	if err != nil || len(categories) != 1 || categories[0].ID != secondCategory.ID {
		t.Fatalf("categories=%+v err=%v", categories, err)
	}
	foreignCategory := taskInput(1)
	foreignCategory.CategoryID = &category.ID
	_, err = f.s.CreateTask(ctx, other, "foreign-category", foreignCategory)
	code(t, err, "NOT_FOUND")
	secondInput := taskInput(2)
	secondInput.Name = "运动"
	secondTask, err := f.s.CreateTask(ctx, other, "task-key", secondInput)
	if err != nil || secondTask.ID == firstTask.ID {
		t.Fatalf("second task=%+v err=%v", secondTask, err)
	}
	for _, item := range []struct {
		p    account.Principal
		task Task
	}{{f.p, firstTask}, {other, secondTask}} {
		tasks, err := f.s.Tasks(ctx, item.p, true)
		if err != nil || len(tasks) != 1 || tasks[0].ID != item.task.ID {
			t.Fatalf("tasks=%+v err=%v", tasks, err)
		}
	}
	badgeInput := achievementInput()
	badgeInput.Target = 1
	badges := achievementService(f)
	firstBadge, err := badges.Create(ctx, f.p, "badge", badgeInput)
	if err != nil {
		t.Fatal(err)
	}
	secondBadge, err := badges.Create(ctx, other, "badge", badgeInput)
	if err != nil || secondBadge.ID == firstBadge.ID {
		t.Fatalf("badge=%+v err=%v", secondBadge, err)
	}
	first, err := f.s.Create(ctx, f.p, false, "record", CreateInput{TaskID: firstTask.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
	if err != nil {
		t.Fatal(err)
	}
	foreignRule := achievementInput()
	foreignRule.Scope = "tasks"
	foreignRule.TaskIDs = []string{firstTask.ID}
	if _, err := badges.Create(ctx, other, "foreign-scope", foreignRule); err == nil {
		t.Fatal("achievement used another account's task")
	}
	options, err := badges.Options(ctx, other)
	if err != nil || len(options.Tasks) != 1 || options.Tasks[0].ID != secondTask.ID || len(options.Categories) != 1 || options.Categories[0].ID != secondCategory.ID {
		t.Fatalf("options=%+v err=%v", options, err)
	}
	secondList, err := badges.List(ctx, other, false)
	if err != nil || len(secondList.Items) != 1 || secondList.Items[0].Progress != 0 {
		t.Fatalf("other badge=%+v err=%v", secondList, err)
	}
	second, err := f.s.Create(ctx, other, false, "record", CreateInput{TaskID: secondTask.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
	if err != nil || second.Checkin.ID == first.Checkin.ID || second.TaskRemaining != 1 || second.Wallet.Coins != 10 {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	camp, err := f.s.Camp(ctx, other, "")
	if err != nil || camp.Account.ID != other.AccountID || len(camp.Tasks) != 1 || camp.Tasks[0].ID != secondTask.ID || camp.Tasks[0].Remaining != 1 || camp.Wallet.Coins != 10 {
		t.Fatalf("camp=%+v err=%v", camp, err)
	}
	_, err = f.s.Create(ctx, other, false, "foreign-task", CreateInput{TaskID: firstTask.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29"})
	code(t, err, "NOT_FOUND")
	_, err = f.s.Edit(ctx, other, true, first.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "越权"})
	code(t, err, "NOT_FOUND")
	_, err = f.s.Delete(ctx, other, true, first.Checkin.ID, 1)
	code(t, err, "NOT_FOUND")
	_, err = f.s.UpdateTask(ctx, other, firstTask.ID, TaskInput{Name: "越权", IconKey: "book-v1", DailyLimit: 1, Weekdays: []int{1}, Enabled: true, ExpectedVersion: 1})
	code(t, err, "NOT_FOUND")
	_, err = badges.SetEquipped(ctx, other, firstBadge.ID, true)
	code(t, err, "NOT_FOUND")
	own, err := f.s.List(ctx, other, "2026-10-01", "2026-10-29", "", 100)
	if err != nil || len(own.Items) != 1 || own.Items[0].ID != second.Checkin.ID {
		t.Fatalf("own=%+v err=%v", own, err)
	}
	if _, err := f.s.Delete(ctx, f.p, false, first.Checkin.ID, 1); err != nil {
		t.Fatal(err)
	}
	camp, err = f.s.Camp(ctx, other, "")
	if err != nil || camp.Wallet.Coins != 10 || len(camp.Tasks) != 1 || camp.Tasks[0].Remaining != 1 {
		t.Fatalf("other camp changed=%+v err=%v", camp, err)
	}
}

// TestGroupReadsFollowCurrentMembership uses three accounts and checks each read boundary after leaving.
func TestGroupReadsFollowCurrentMembership(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	peer := addAccount(t, f, "peer")
	stranger := addAccount(t, f, "stranger")
	group, err := f.s.Accounts.CreateGroup(ctx, "学习组")
	if err != nil {
		t.Fatal(err)
	}
	task := createTask(t, f, 1)
	got, err := f.s.Create(ctx, f.p, false, "record", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", Text: "完整记录"})
	if err != nil {
		t.Fatal(err)
	}
	// A backfill created before joining is still part of the shared effective history.
	if _, err := f.s.Create(ctx, f.p, true, "earlier-record", CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, BusinessDate: "2026-10-28", Text: "入组前记录"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Accounts.JoinGroup(ctx, f.p, group.ID, "manage password"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Accounts.JoinGroup(ctx, peer, group.ID, "manage password"); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListFor(ctx, peer, f.p.AccountID, "2026-10-01", "2026-10-29", "", 100)
	if err != nil || len(page.Items) != 2 || page.Items[0].ID != got.Checkin.ID || page.Items[0].Text != "完整记录" || page.Items[0].CanEdit || page.Items[0].CanDelete {
		t.Fatalf("shared=%+v err=%v", page, err)
	}
	_, err = f.s.Edit(ctx, peer, true, got.Checkin.ID, EditInput{ExpectedVersion: 1, Text: "越权"})
	code(t, err, "NOT_FOUND")
	_, err = f.s.Delete(ctx, peer, true, got.Checkin.ID, 1)
	code(t, err, "NOT_FOUND")
	stats, err := f.s.StatsFor(ctx, peer, f.p.AccountID, "2026-10-01", "2026-10-29")
	if err != nil || stats.TotalCount != 2 {
		t.Fatalf("stats=%+v err=%v", stats, err)
	}
	calendar, err := f.s.CalendarFor(ctx, peer, f.p.AccountID, "2026-10")
	if err != nil || calendar.Days[28].Count != 1 || calendar.Days[27].Count != 1 {
		t.Fatalf("calendar=%+v err=%v", calendar, err)
	}
	today, err := f.s.MemberToday(ctx, peer, f.p.AccountID)
	if err != nil || len(today.Tasks) != 1 || today.Tasks[0].Completed != 1 || today.Tasks[0].Remaining != 0 {
		t.Fatalf("today=%+v err=%v", today, err)
	}
	_, err = f.s.ListFor(ctx, stranger, f.p.AccountID, "2026-10-01", "2026-10-29", "", 100)
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.StatsFor(ctx, stranger, f.p.AccountID, "2026-10-01", "2026-10-29")
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.CalendarFor(ctx, stranger, f.p.AccountID, "2026-10")
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.MemberToday(ctx, stranger, f.p.AccountID)
	code(t, err, "GROUP_ACCESS_DENIED")
	if _, err := f.s.Accounts.LeaveGroup(ctx, f.p, "manage password"); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.ListFor(ctx, peer, f.p.AccountID, "2026-10-01", "2026-10-29", "", 100)
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.StatsFor(ctx, peer, f.p.AccountID, "2026-10-01", "2026-10-29")
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.CalendarFor(ctx, peer, f.p.AccountID, "2026-10")
	code(t, err, "GROUP_ACCESS_DENIED")
	_, err = f.s.MemberToday(ctx, peer, f.p.AccountID)
	code(t, err, "GROUP_ACCESS_DENIED")
}
