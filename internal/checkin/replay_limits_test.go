package checkin

import (
	"context"
	"testing"
)

// TestReplayUsesCommittedRules recovers successful commands after deployment limits become stricter.
func TestReplayUsesCommittedRules(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	categoryInput := CategoryInput{Name: "  学习习惯  "}
	category, err := f.s.CreateCategory(ctx, f.p, "old-category", categoryInput)
	if err != nil {
		t.Fatal(err)
	}
	taskInput := taskInput(2)
	taskInput.Name = "  原始任务  "
	task, err := f.s.CreateTask(ctx, f.p, "old-task", taskInput)
	if err != nil {
		t.Fatal(err)
	}
	input := CreateInput{TaskID: task.ID, ExpectedTaskVersion: 1, ExpectedToday: "2026-10-29", Text: "已经提交但响应丢失的内容"}
	record, err := f.s.Create(ctx, f.p, false, "old-record", input)
	if err != nil {
		t.Fatal(err)
	}
	f.s.Config.Limits.NameMax = 1
	f.s.Config.Limits.RewardMax = 0
	f.s.Config.Limits.TextMax = 1
	gotCategory, err := f.s.CreateCategory(ctx, f.p, "old-category", categoryInput)
	if err != nil || gotCategory.ID != category.ID {
		t.Errorf("category replay=%+v error=%v", gotCategory, err)
	}
	gotTask, err := f.s.CreateTask(ctx, f.p, "old-task", taskInput)
	if err != nil || gotTask.ID != task.ID {
		t.Errorf("task replay=%+v error=%v", gotTask, err)
	}
	gotRecord, err := f.s.Create(ctx, f.p, false, "old-record", input)
	if err != nil || gotRecord.Checkin.ID != record.Checkin.ID {
		t.Errorf("record replay=%+v error=%v", gotRecord, err)
	}
	_, err = f.s.CreateCategory(ctx, f.p, "new-category", categoryInput)
	code(t, err, "INVALID_REQUEST")
	_, err = f.s.CreateTask(ctx, f.p, "new-task", taskInput)
	code(t, err, "INVALID_REQUEST")
	_, err = f.s.Create(ctx, f.p, false, "new-record", input)
	code(t, err, "INVALID_REQUEST")
	assertLedger(t, f.s.DB)
}
