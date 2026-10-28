package checkin

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// CalendarDay keeps each date target bounded even when many records share that date.
type CalendarDay struct {
	Date      string   `json:"date"`       // Date to use when opening the paginated record list.
	Count     int64    `json:"count"`      // Number of effective records belonging to this date.
	Icons     []string `json:"icons"`      // At most three recorded icon snapshots.
	MoreCount int64    `json:"more_count"` // Records omitted from the bounded icon preview.
}

// CalendarResult includes empty and future dates so clients can render a complete month.
type CalendarResult struct {
	Month string        `json:"month"` // Requested calendar month.
	Days  []CalendarDay `json:"days"`  // Dates in ascending order.
}

// StatsItem counts by immutable identity while using the current task presentation.
type StatsItem struct {
	TaskID  string `json:"task_id"`  // Stable task identity, retained after soft deletion.
	Name    string `json:"name"`     // Current name, falling back to a retained snapshot.
	IconKey string `json:"icon_key"` // Current icon or retained snapshot.
	Count   int64  `json:"count"`    // Effective records, including repeat completions on one date.
}

// StatsResult presents inclusive-range totals and task counts from the same snapshot.
type StatsResult struct {
	StartDate  string      `json:"start_date"`  // Inclusive first date.
	EndDate    string      `json:"end_date"`    // Inclusive final date.
	TotalCount int64       `json:"total_count"` // Sum of all task counts.
	ActiveDays int64       `json:"active_days"` // Distinct dates with an effective record.
	Items      []StatsItem `json:"items"`       // Descending count, then task identity for stable ties.
}

// Calendar summarizes a validated month without sending an unbounded list of record icons.
func (s *Service) Calendar(ctx context.Context, p account.Principal, month string) (CalendarResult, error) {
	out := CalendarResult{Month: month, Days: []CalendarDay{}}
	first, err := time.Parse("2006-01", month)
	if err != nil || first.Format("2006-01") != month {
		return out, core.Fail(422, "INVALID_DATE_RANGE")
	}
	last := first.AddDate(0, 1, -1)
	for day := first; !day.After(last); day = day.AddDate(0, 0, 1) {
		out.Days = append(out.Days, CalendarDay{Date: day.Format(time.DateOnly), Icons: []string{}})
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return out, err
	}
	rows, err := tx.QueryContext(ctx, `WITH ranked AS (
		SELECT business_date,task_icon_snapshot,
		COUNT(*) OVER (PARTITION BY business_date) AS total,
		ROW_NUMBER() OVER (PARTITION BY business_date ORDER BY created_at,id) AS position
		FROM checkins WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ?
	) SELECT business_date,total,task_icon_snapshot FROM ranked WHERE position<=3 ORDER BY business_date,position`, first.Format(time.DateOnly), last.Format(time.DateOnly))
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var date, icon string
		var count int64
		if err := rows.Scan(&date, &count, &icon); err != nil {
			rows.Close()
			return out, err
		}
		parsed, err := core.ParseDate(date)
		if err != nil {
			rows.Close()
			return out, err
		}
		day := &out.Days[parsed.Day()-1]
		day.Count = count
		day.Icons = append(day.Icons, icon)
		day.MoreCount = count - int64(len(day.Icons))
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// Stats validates dates against the server clock and reads every aggregate in one transaction.
func (s *Service) Stats(ctx context.Context, p account.Principal, start, end string) (StatsResult, error) {
	out := StatsResult{StartDate: start, EndDate: end, Items: []StatsItem{}}
	first, err := core.ParseDate(start)
	if err != nil {
		return out, err
	}
	last, err := core.ParseDate(end)
	if err != nil {
		return out, err
	}
	if last.Before(first) || int(last.Sub(first)/(24*time.Hour))+1 > s.Config.Limits.StatsDaysMax {
		return out, core.Fail(422, "INVALID_DATE_RANGE")
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err := account.Authorize(ctx, tx, p, false, now); err != nil {
		return out, err
	}
	if end > core.Today(now) {
		return out, core.Fail(422, "INVALID_DATE_RANGE")
	}
	out, err = readStatistics(ctx, tx, start, end)
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// readStatistics uses only its supplied read transaction, including the summary query.
func readStatistics(ctx context.Context, tx *sql.Tx, start, end string) (StatsResult, error) {
	out := StatsResult{StartDate: start, EndDate: end, Items: []StatsItem{}}
	rows, err := tx.QueryContext(ctx, `SELECT c.task_id,COALESCE(t.name,MAX(c.task_name_snapshot)),COALESCE(t.icon_key,MAX(c.task_icon_snapshot)),COUNT(*)
		FROM checkins c LEFT JOIN tasks t ON t.id=c.task_id
		WHERE c.deleted_at IS NULL AND c.business_date BETWEEN ? AND ?
		GROUP BY c.task_id ORDER BY COUNT(*) DESC,c.task_id`, start, end)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item StatsItem
		if err := rows.Scan(&item.TaskID, &item.Name, &item.IconKey, &item.Count); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, item)
		out.TotalCount += item.Count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	err = tx.QueryRowContext(ctx, "SELECT COUNT(DISTINCT business_date) FROM checkins WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ?", start, end).Scan(&out.ActiveDays)
	return out, err
}
