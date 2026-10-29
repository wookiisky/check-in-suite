package achievement

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// loadFacts retains disabled/deleted task identities and reads only effective check-in records.
func loadFacts(ctx context.Context, tx *sql.Tx) ([]TaskFact, []RecordFact, error) {
	tasks := []TaskFact{}
	records := []RecordFact{}
	indices := map[string]int{}
	rows, err := tx.QueryContext(ctx, "SELECT id,category_id FROM tasks ORDER BY id")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var task TaskFact
		if err = rows.Scan(&task.ID, &task.CategoryID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		indices[task.ID] = len(tasks)
		tasks = append(tasks, task)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT task_id,start_date,weekday_mask,enabled FROM task_schedule_history ORDER BY task_id,start_date")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id string
		var schedule Schedule
		if err = rows.Scan(&id, &schedule.StartDate, &schedule.WeekdayMask, &schedule.Enabled); err != nil {
			rows.Close()
			return nil, nil, err
		}
		index := indices[id]
		tasks[index].Schedules = append(tasks[index].Schedules, schedule)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT task_id,business_date,coin_reward_snapshot,diamond_reward_snapshot FROM checkins WHERE deleted_at IS NULL ORDER BY business_date,id")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var record RecordFact
		if err = rows.Scan(&record.TaskID, &record.Date, &record.Coins, &record.Diamonds); err != nil {
			rows.Close()
			return nil, nil, err
		}
		records = append(records, record)
	}
	err = rows.Err()
	rows.Close()
	return tasks, records, err
}

// Reconcile changes progress, qualification and equipment within the caller's fact mutation.
func Reconcile(ctx context.Context, tx *sql.Tx, now time.Time) error {
	items, err := readAchievements(ctx, tx, "")
	if err != nil || len(items) == 0 {
		return err
	}
	tasks, records, err := loadFacts(ctx, tx)
	if err != nil {
		return err
	}
	for _, item := range items {
		rule := Rule{Metric: item.Metric, Scope: item.Scope, CategoryID: item.CategoryID, TaskIDs: item.TaskIDs, Target: item.Target, WindowDays: item.WindowDays}
		progress := Evaluate(rule, tasks, records, core.Today(now))
		qualified := progress >= item.Target && (item.Qualified || (item.Enabled && !item.Deleted))
		if progress == item.Progress && qualified == item.Qualified {
			continue
		}
		// Requalification records a new actual grant time and leaves equipment off.
		_, err = tx.ExecContext(ctx, `UPDATE achievements SET progress=?,qualified=?,equipped=CASE WHEN ?=0 THEN 0 ELSE equipped END,earned_at=CASE WHEN qualified=0 AND ?=1 THEN ? ELSE earned_at END WHERE id=?`, progress, qualified, qualified, qualified, now.UnixMilli(), item.ID)
		if err != nil {
			return err
		}
	}
	return nil
}

// RecordSchedule replaces only this business day's version, preserving all earlier frequencies.
func RecordSchedule(ctx context.Context, tx *sql.Tx, taskID, date string, mask int, enabled bool) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO task_schedule_history(task_id,start_date,weekday_mask,enabled) VALUES(?,?,?,?) ON CONFLICT(task_id,start_date) DO UPDATE SET weekday_mask=excluded.weekday_mask,enabled=excluded.enabled`, taskID, date, mask, enabled)
	return err
}

// ExtendInitialSchedule accommodates existing backfill authority before a task's creation date.
func ExtendInitialSchedule(ctx context.Context, tx *sql.Tx, taskID, date string) error {
	var first string
	if err := tx.QueryRowContext(ctx, "SELECT min(start_date) FROM task_schedule_history WHERE task_id=?", taskID).Scan(&first); err != nil {
		return err
	}
	if date >= first {
		return nil
	}
	_, err := tx.ExecContext(ctx, "UPDATE task_schedule_history SET start_date=? WHERE task_id=? AND start_date=?", date, taskID, first)
	return err
}
