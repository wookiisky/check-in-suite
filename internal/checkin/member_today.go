package checkin

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// MemberTaskStatus reports a scheduled task without exposing another account's economic state.
type MemberTaskStatus struct {
	ID         string `json:"id"`          // Stable task identity.
	Name       string `json:"name"`        // Current task name.
	IconKey    string `json:"icon_key"`    // Controlled icon identity.
	DailyLimit int64  `json:"daily_limit"` // Number of completions allowed today.
	Completed  int64  `json:"completed"`   // Effective records completed today.
	Remaining  int64  `json:"remaining"`   // Remaining completions, never negative.
}

// MemberTodayResult keeps the business date and task counts from one database snapshot.
type MemberTodayResult struct {
	Today string             `json:"today"` // Taipei business date used for all counts.
	Tasks []MemberTaskStatus `json:"tasks"` // All enabled scheduled tasks, including fully completed tasks.
}

// MemberToday includes completed tasks so group members can see both progress and remaining work.
func (s *Service) MemberToday(ctx context.Context, p account.Principal, targetID int64) (MemberTodayResult, error) {
	out := MemberTodayResult{Tasks: []MemberTaskStatus{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err := account.AuthorizeRead(ctx, tx, p, targetID, now); err != nil {
		return out, err
	}
	out.Today = core.Today(now)
	date, _ := core.ParseDate(out.Today)
	day := int(date.Weekday())
	if day == 0 {
		day = 7
	}
	rows, err := tx.QueryContext(ctx, `SELECT t.id,t.name,t.icon_key,t.daily_limit,
  (SELECT COUNT(*) FROM checkins c WHERE c.account_id=t.account_id AND c.task_id=t.id AND c.business_date=? AND c.deleted_at IS NULL)
  FROM tasks t WHERE t.account_id=? AND t.deleted_at IS NULL AND t.enabled=1 AND (t.weekday_mask & ?) != 0 ORDER BY t.name,t.id`, out.Today, targetID, 1<<(day-1))
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var task MemberTaskStatus
		if err := rows.Scan(&task.ID, &task.Name, &task.IconKey, &task.DailyLimit, &task.Completed); err != nil {
			rows.Close()
			return out, err
		}
		task.Remaining = max(int64(0), task.DailyLimit-task.Completed)
		out.Tasks = append(out.Tasks, task)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}
