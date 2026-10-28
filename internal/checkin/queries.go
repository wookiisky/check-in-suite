package checkin

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// Camp reads the task counts, profile and balance from a single consistent database snapshot.
func (s *Service) Camp(ctx context.Context, p account.Principal, categoryID string) (Camp, error) {
	var out Camp
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err := account.Authorize(ctx, tx, p, false, now); err != nil {
		return out, err
	}
	out = Camp{Today: core.Today(now), ServerNow: now.UTC().Format(time.RFC3339Nano), Timezone: "Asia/Taipei", Tasks: []AvailableTask{}}
	date, _ := core.ParseDate(out.Today)
	day := int(date.Weekday())
	if day == 0 {
		day = 7
	}
	mask := 1 << (day - 1)
	var scheduled int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND enabled=1 AND (weekday_mask & ?) != 0", mask).Scan(&scheduled); err != nil {
		return out, err
	}
	out.HasScheduledTasks = scheduled > 0
	query := "SELECT " + taskColumns + ",daily_limit-(SELECT count(*) FROM checkins WHERE checkins.task_id=tasks.id AND business_date=? AND deleted_at IS NULL) AS remaining FROM tasks WHERE deleted_at IS NULL AND enabled=1 AND (weekday_mask & ?) != 0"
	args := []any{out.Today, mask}
	if categoryID != "" {
		query += " AND category_id=?"
		args = append(args, categoryID)
	}
	query += " ORDER BY name,id"
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var t AvailableTask
		var weekdaysMask int
		if err := rows.Scan(&t.ID, &t.CategoryID, &t.Name, &t.IconKey, &t.CoinReward, &t.DiamondReward, &t.DailyLimit, &weekdaysMask, &t.Enabled, &t.Version, &t.Remaining); err != nil {
			rows.Close()
			return out, err
		}
		t.Weekdays = weekdays(weekdaysMask)
		if t.Remaining > 0 {
			out.Tasks = append(out.Tasks, t)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	out.Categories, err = readCategories(ctx, tx)
	if err != nil {
		return out, err
	}
	out.Wallet, err = wallet.Get(ctx, tx)
	if err != nil {
		return out, err
	}
	err = tx.QueryRowContext(ctx, "SELECT id,username,display_name,version,music_enabled,effects_enabled,reduce_motion FROM accounts WHERE id=1").Scan(&out.Account.ID, &out.Account.Username, &out.Account.DisplayName, &out.Account.Version, &out.Account.Preferences.MusicEnabled, &out.Account.Preferences.EffectsEnabled, &out.Account.Preferences.ReduceMotion)
	if err != nil {
		return out, err
	}
	out.Equipment, err = shop.ReadEquipment(ctx, tx)
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// recordCursor is bound to the active date filter so it cannot silently paginate another view.
type recordCursor struct {
	Start   string `json:"start"`   // Original inclusive start date.
	End     string `json:"end"`     // Original inclusive end date.
	Date    string `json:"date"`    // Last emitted record's business date.
	Created int64  `json:"created"` // Last emitted record's creation milliseconds.
	ID      string `json:"id"`      // Tie-breaker for records with identical timestamps.
}

// List walks effective records by date, actual creation time and stable identity.
func (s *Service) List(ctx context.Context, p account.Principal, start, end, cursor string, limit int) (RecordPage, error) {
	out := RecordPage{Items: []Record{}}
	first, err := core.ParseDate(start)
	if err != nil {
		return out, err
	}
	last, err := core.ParseDate(end)
	if err != nil {
		return out, err
	}
	if last.Before(first) || int(last.Sub(first)/(24*time.Hour))+1 > s.Config.Limits.ListDaysMax {
		return out, core.Fail(422, "INVALID_DATE_RANGE")
	}
	if limit < 1 || limit > 100 {
		return out, core.Invalid("limit", "INVALID_NUMBER")
	}
	var after recordCursor
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(raw, &after) != nil || after.Start != start || after.End != end || after.ID == "" {
			return out, core.Invalid("cursor", "INVALID_CURSOR")
		}
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
	query := "SELECT " + recordColumns + " FROM checkins WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ?"
	args := []any{start, end}
	if cursor != "" {
		query += " AND (business_date,created_at,id) < (?,?,?)"
		args = append(args, after.Date, after.Created, after.ID)
	}
	query += " ORDER BY business_date DESC,created_at DESC,id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			return out, err
		}
		out.Items = append(out.Items, withActions(record, core.Today(now)))
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		tail := out.Items[limit-1]
		created, err := time.Parse(time.RFC3339Nano, tail.CreatedAt)
		if err != nil {
			return out, err
		}
		raw, err := json.Marshal(recordCursor{Start: start, End: end, Date: tail.BusinessDate, Created: created.UnixMilli(), ID: tail.ID})
		if err != nil {
			return out, err
		}
		next := base64.RawURLEncoding.EncodeToString(raw)
		out.NextCursor = &next
	}
	return out, nil
}
