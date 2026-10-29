package checkin

import (
	"context"
	"reflect"
	"testing"
)

// TestTaskIslandActivities keeps configured links through omitted updates and removes them explicitly.
func TestTaskIslandActivities(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	input := taskInput(2)
	input.UnlockActivities = []string{"run", "read", "read"}
	task, err := f.s.CreateTask(ctx, f.p, "island-task", input)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"read", "run"}
	if !reflect.DeepEqual(task.UnlockActivities, want) {
		t.Fatalf("activities=%v", task.UnlockActivities)
	}
	input.UnlockActivities = []string{"read", "run"}
	replay, err := f.s.CreateTask(ctx, f.p, "island-task", input)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay=%+v error=%v", replay, err)
	}
	changed := input
	changed.UnlockActivities = []string{"ball"}
	_, err = f.s.CreateTask(ctx, f.p, "island-task", changed)
	code(t, err, "IDEMPOTENCY_CONFLICT")
	input.ExpectedVersion = task.Version
	input.UnlockActivities = nil
	input.Enabled = false
	task, err = f.s.UpdateTask(ctx, f.p, task.ID, input)
	if err != nil || !reflect.DeepEqual(task.UnlockActivities, want) {
		t.Fatalf("disable=%+v error=%v", task, err)
	}
	input.ExpectedVersion = task.Version - 1
	input.UnlockActivities = []string{}
	_, err = f.s.UpdateTask(ctx, f.p, task.ID, input)
	code(t, err, "VERSION_CONFLICT")
	items, err := f.s.Tasks(ctx, f.p, true)
	if err != nil || len(items) != 1 || !reflect.DeepEqual(items[0].UnlockActivities, want) {
		t.Fatalf("tasks=%+v error=%v", items, err)
	}
	input.ExpectedVersion = task.Version
	task, err = f.s.UpdateTask(ctx, f.p, task.ID, input)
	if err != nil || task.UnlockActivities == nil || len(task.UnlockActivities) != 0 {
		t.Fatalf("clear=%+v error=%v", task, err)
	}
}

// TestTaskIslandActivitiesValidate rejects unknown capabilities and returns empty arrays for ordinary tasks.
func TestTaskIslandActivitiesValidate(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	input := taskInput(2)
	input.UnlockActivities = []string{"swim"}
	_, err := f.s.CreateTask(ctx, f.p, "bad-activity", input)
	code(t, err, "INVALID_REQUEST")
	input.UnlockActivities = nil
	task, err := f.s.CreateTask(ctx, f.p, "ordinary-task", input)
	if err != nil || task.UnlockActivities == nil {
		t.Fatalf("task=%+v error=%v", task, err)
	}
	camp, err := f.s.Camp(ctx, f.p, "")
	if err != nil || len(camp.Tasks) != 1 || camp.Tasks[0].UnlockActivities == nil {
		t.Fatalf("camp=%+v error=%v", camp, err)
	}
}

// TestTaskIslandActivitiesHistoricalReceipt keeps pre-upgrade replay responses conformant without changing their hash.
func TestTaskIslandActivitiesHistoricalReceipt(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	input := taskInput(1)
	task, err := f.s.CreateTask(ctx, f.p, "legacy-task", input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.ExecContext(ctx, "UPDATE idempotency_requests SET response_json=json_remove(response_json,'$.unlock_activities') WHERE key='legacy-task'"); err != nil {
		t.Fatal(err)
	}
	replay, err := f.s.CreateTask(ctx, f.p, "legacy-task", input)
	if err != nil || replay.ID != task.ID || replay.UnlockActivities == nil {
		t.Fatalf("historical replay=%+v err=%v", replay, err)
	}
}
