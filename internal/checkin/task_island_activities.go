package checkin

import (
	"context"
	"database/sql"
)

// replaceTaskIslandActivities replaces configured links inside the task's existing write transaction.
func replaceTaskIslandActivities(ctx context.Context, tx *sql.Tx, taskID string, activities []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM task_island_activities WHERE task_id=?", taskID); err != nil {
		return err
	}
	for _, activity := range activities {
		if _, err := tx.ExecContext(ctx, "INSERT INTO task_island_activities(task_id,activity) VALUES(?,?)", taskID, activity); err != nil {
			return err
		}
	}
	return nil
}
