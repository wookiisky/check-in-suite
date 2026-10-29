package island

import (
	"context"
	"database/sql"
	"slices"
)

// readActivityAccess derives eligibility from effective records in the layout's database snapshot.
func readActivityAccess(ctx context.Context, tx *sql.Tx, catalog []Definition, today string) ([]ActivityAccess, error) {
	activities := make([]string, 0)
	for _, definition := range catalog {
		if definition.Activity != "" && !slices.Contains(activities, definition.Activity) {
			activities = append(activities, definition.Activity)
		}
	}
	slices.Sort(activities)
	access := make([]ActivityAccess, 0, len(activities))
	for _, activity := range activities {
		access = append(access, ActivityAccess{Activity: activity, Available: true, Tasks: []ActivityTask{}})
	}
	// Disabled tasks keep their association and already-earned access. Deleting a task removes its requirement.
	rows, err := tx.QueryContext(ctx, `SELECT a.activity,t.id,t.name,t.enabled,
		EXISTS(SELECT 1 FROM checkins c WHERE c.task_id=t.id AND c.business_date=? AND c.deleted_at IS NULL)
		FROM task_island_activities a JOIN tasks t ON t.id=a.task_id
		WHERE t.deleted_at IS NULL ORDER BY a.activity,t.name,t.id`, today)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var activity string
		var task ActivityTask
		var completed bool
		if err = rows.Scan(&activity, &task.ID, &task.Name, &task.Enabled, &completed); err != nil {
			return nil, err
		}
		index := slices.Index(activities, activity)
		if index < 0 {
			continue
		}
		entry := &access[index]
		if len(entry.Tasks) == 0 {
			entry.Available = false
		}
		entry.Tasks = append(entry.Tasks, task)
		entry.Available = entry.Available || completed
	}
	return access, rows.Err()
}
