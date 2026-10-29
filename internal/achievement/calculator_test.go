package achievement

import (
	"reflect"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// number returns an optional inclusive calendar window for table-driven examples.
func number(value int) *int { return &value }

// label names the category identity used by a task or a rule.
func label(value string) *string { return &value }

// scheduledTask builds a task with its initial historical weekly schedule.
func scheduledTask(id string, mask int) TaskFact {
	return TaskFact{ID: id, Schedules: []Schedule{{StartDate: "0001-01-01", WeekdayMask: mask, Enabled: true}}}
}

// TestEvaluateMetrics verifies effective facts rather than stored progress counters.
func TestEvaluateMetrics(t *testing.T) {
	tasks := []TaskFact{scheduledTask("read", 127), scheduledTask("run", 127)}
	tasks[0].CategoryID = label("study")
	tasks[1].CategoryID = label("health")
	records := []RecordFact{
		{TaskID: "read", Date: "2026-10-01", Coins: 5, Diamonds: 1},
		{TaskID: "read", Date: "2026-10-01", Coins: 7, Diamonds: 2},
		{TaskID: "run", Date: "2026-10-02", Coins: 11, Diamonds: 3},
		{TaskID: "read", Date: "2026-10-05", Coins: 13, Diamonds: 4},
		{TaskID: "read", Date: "2026-11-01", Coins: 1000, Diamonds: 1000},
	}
	for _, test := range []struct {
		name string
		rule Rule
		want int64
	}{
		{"count", Rule{Metric: "count", Scope: "all"}, 4},
		{"days deduplicate repeated task", Rule{Metric: "days", Scope: "all"}, 3},
		{"original coins", Rule{Metric: "coins", Scope: "all"}, 36},
		{"original diamonds", Rule{Metric: "diamonds", Scope: "all"}, 10},
		{"current category", Rule{Metric: "count", Scope: "category", CategoryID: label("study")}, 3},
		{"explicit tasks", Rule{Metric: "coins", Scope: "tasks", TaskIDs: []string{"run"}}, 11},
		{"two day historical best", Rule{Metric: "count", Scope: "all", WindowDays: number(2)}, 3},
		{"one day count", Rule{Metric: "count", Scope: "all", WindowDays: number(1)}, 2},
		{"one day days", Rule{Metric: "days", Scope: "all", WindowDays: number(1)}, 1},
		{"inclusive four day window", Rule{Metric: "coins", Scope: "all", WindowDays: number(4)}, 24},
		{"five day window", Rule{Metric: "coins", Scope: "all", WindowDays: number(5)}, 36},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Evaluate(test.rule, tasks, records, "2026-10-29"); got != test.want {
				t.Fatalf("progress = %d, want %d", got, test.want)
			}
		})
	}
}

// TestEvaluateStreak follows planned days and requires every task scheduled that day.
func TestEvaluateStreak(t *testing.T) {
	mondays := scheduledTask("read", 1)
	for _, test := range []struct {
		name    string
		tasks   []TaskFact
		records []RecordFact
		window  *int
		want    int64
	}{
		{"consecutive Mondays", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-12"}, {TaskID: "read", Date: "2026-10-19"}}, nil, 3},
		{"missing Monday interrupts", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-19"}}, nil, 1},
		{"one task missing", []TaskFact{mondays, scheduledTask("run", 1)}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "run", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-12"}}, nil, 1},
		{"same day repeats count once", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-05"}}, nil, 1},
		{"seven days exclude next Monday", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-12"}}, number(7), 1},
		{"eight days include next Monday", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-12"}}, number(8), 2},
		{"no records never grants", []TaskFact{mondays}, nil, nil, 0},
		{"future record excluded", []TaskFact{mondays}, []RecordFact{{TaskID: "read", Date: "2026-11-02"}}, nil, 0},
		{"backfill before task creation", []TaskFact{{ID: "read", Schedules: []Schedule{{StartDate: "2026-10-20", WeekdayMask: 1, Enabled: true}}}}, []RecordFact{{TaskID: "read", Date: "2026-10-05"}}, nil, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := Evaluate(Rule{Metric: "streak", Scope: "all", WindowDays: test.window}, test.tasks, test.records, "2026-10-29")
			if got != test.want {
				t.Fatalf("progress = %d, want %d", got, test.want)
			}
		})
	}
}

// TestEvaluateScheduleChanges preserves old frequency and truncates only future obligations.
func TestEvaluateScheduleChanges(t *testing.T) {
	task := scheduledTask("read", 1)
	task.Schedules = append(task.Schedules, Schedule{StartDate: "2026-10-20", WeekdayMask: 127, Enabled: true})
	records := []RecordFact{{TaskID: "read", Date: "2026-10-05"}, {TaskID: "read", Date: "2026-10-12"}, {TaskID: "read", Date: "2026-10-19"}, {TaskID: "read", Date: "2026-10-20"}, {TaskID: "read", Date: "2026-10-21"}}
	rule := Rule{Metric: "streak", Scope: "all"}
	if got := Evaluate(rule, []TaskFact{task}, records, "2026-10-29"); got != 5 {
		t.Fatalf("new daily schedule erased old weekly continuity: got %d", got)
	}
	task.Schedules = append(task.Schedules, Schedule{StartDate: "2026-10-22", WeekdayMask: 127, Enabled: false})
	if got := Evaluate(rule, []TaskFact{task}, records, "2026-10-29"); got != 5 {
		t.Fatalf("deletion erased historical continuity: got %d", got)
	}
	records = append(records[:1], records[2:]...)
	if got := Evaluate(rule, []TaskFact{task}, records, "2026-10-29"); got != 3 {
		t.Fatalf("removed past obligation was ignored: got %d", got)
	}
}

// TestEvaluateSaturatesAndDoesNotMutate protects the public integer range and caller-owned facts.
func TestEvaluateSaturatesAndDoesNotMutate(t *testing.T) {
	tasks := []TaskFact{scheduledTask("read", 127)}
	records := []RecordFact{{TaskID: "read", Date: "2026-10-02", Coins: core.MaxInteger - 1}, {TaskID: "read", Date: "2026-10-01", Coins: 2}}
	before := append([]RecordFact(nil), records...)
	if got := Evaluate(Rule{Metric: "coins", Scope: "all", WindowDays: number(2)}, tasks, records, "2026-10-29"); got != core.MaxInteger {
		t.Fatalf("saturated progress = %d", got)
	}
	if !reflect.DeepEqual(before, records) {
		t.Fatalf("input changed: got %#v, want %#v", records, before)
	}
}
