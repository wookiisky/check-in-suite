package checkin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
)

// begin authorizes after acquiring the write lock, closing the preflight-to-write race.
func (s *Service) begin(ctx context.Context, p account.Principal, management bool) (*sql.Tx, time.Time, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, time.Time{}, err
	}
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, management, now); err != nil {
		tx.Rollback()
		return nil, now, err
	}
	return tx, now, nil
}

// validCategory trims names and bounds numeric values at the public JSON contract.
func (s *Service) validCategory(in *CategoryInput) error {
	in.Name = strings.TrimSpace(in.Name)
	if err := core.Text("name", in.Name, 1, s.Config.Limits.NameMax); err != nil {
		return err
	}
	if in.SortOrder < 0 || in.SortOrder > core.MaxInteger {
		return core.Invalid("sort_order", "INVALID_NUMBER")
	}
	return nil
}

// CreateCategory replays committed creation without creating a second category.
func (s *Service) CreateCategory(ctx context.Context, p account.Principal, key string, in CategoryInput) (Category, error) {
	var result Category
	in.Name = strings.TrimSpace(in.Name)
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	hash, err := idempotency.Hash("category.create", in)
	if err != nil {
		return result, err
	}
	saved, err := idempotency.Lookup(ctx, tx, "category.create", key, hash)
	if err != nil {
		return result, err
	}
	if saved != nil {
		err = json.Unmarshal(saved.JSON, &result)
		return result, err
	}
	if err := s.validCategory(&in); err != nil {
		return result, err
	}
	result = Category{ID: core.ID(), Name: in.Name, SortOrder: in.SortOrder, Version: 1}
	if _, err = tx.ExecContext(ctx, "INSERT INTO categories(id,name,sort_order,version,created_at,updated_at) VALUES(?,?,?,1,?,?)", result.ID, result.Name, result.SortOrder, now.UnixMilli(), now.UnixMilli()); err != nil {
		return result, err
	}
	if err = idempotency.Save(ctx, tx, "category.create", key, hash, result.ID, 201, result, now); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// UpdateCategory changes only the current configuration when its version still matches.
func (s *Service) UpdateCategory(ctx context.Context, p account.Principal, id string, in CategoryInput) (Category, error) {
	var result Category
	if err := s.validCategory(&in); err != nil {
		return result, err
	}
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	result, err = categoryByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if result.Version != in.ExpectedVersion {
		return result, core.VersionConflict(result.Version)
	}
	result.Name = in.Name
	result.SortOrder = in.SortOrder
	result.Version++
	_, err = tx.ExecContext(ctx, "UPDATE categories SET name=?,sort_order=?,version=?,updated_at=? WHERE id=?", result.Name, result.SortOrder, result.Version, now.UnixMilli(), id)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// DeleteCategory refuses any remaining task reference, including disabled tasks.
func (s *Service) DeleteCategory(ctx context.Context, p account.Principal, id string, version int64) error {
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	item, err := categoryByID(ctx, tx, id)
	if err != nil {
		return err
	}
	if item.Version != version {
		return core.VersionConflict(item.Version)
	}
	var n int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM tasks WHERE category_id=? AND deleted_at IS NULL", id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return core.Fail(409, "CATEGORY_NOT_EMPTY")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE categories SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?", now.UnixMilli(), now.UnixMilli(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// categoryByID returns a stable not-found error instead of leaking SQL diagnostics.
func categoryByID(ctx context.Context, tx *sql.Tx, id string) (Category, error) {
	var c Category
	err := tx.QueryRowContext(ctx, "SELECT id,name,sort_order,version FROM categories WHERE id=? AND deleted_at IS NULL", id).Scan(&c.ID, &c.Name, &c.SortOrder, &c.Version)
	if errors.Is(err, sql.ErrNoRows) {
		err = core.Fail(404, "NOT_FOUND")
	}
	return c, err
}

// readCategories is shared by ordinary configuration reads and the camp snapshot.
func readCategories(ctx context.Context, tx *sql.Tx) ([]Category, error) {
	items := []Category{}
	rows, err := tx.QueryContext(ctx, "SELECT id,name,sort_order,version FROM categories WHERE deleted_at IS NULL ORDER BY sort_order,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.Name, &c.SortOrder, &c.Version); err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, rows.Err()
}

// Categories reads the current category list under real session authorization.
func (s *Service) Categories(ctx context.Context, p account.Principal) ([]Category, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return nil, err
	}
	return readCategories(ctx, tx)
}

// normalizeTask canonicalizes inputs without applying limits that may change after a successful command.
func normalizeTask(in *TaskInput) {
	in.Name = strings.TrimSpace(in.Name)
	in.Weekdays = slices.Clone(in.Weekdays)
	slices.Sort(in.Weekdays)
	in.Weekdays = slices.Compact(in.Weekdays)
	if in.UnlockActivities != nil {
		in.UnlockActivities = slices.Clone(in.UnlockActivities)
		slices.Sort(in.UnlockActivities)
		in.UnlockActivities = slices.Compact(in.UnlockActivities)
	}
}

// validTask checks current creation rules only after an existing command has had a chance to replay.
func (s *Service) validTask(in *TaskInput) error {
	if err := core.Text("name", in.Name, 1, s.Config.Limits.NameMax); err != nil {
		return err
	}
	if !assets.Valid(in.IconKey, assets.KindIcon) {
		return core.Invalid("icon_key", "INVALID_ASSET")
	}
	if in.CoinReward < 0 || in.CoinReward > s.Config.Limits.RewardMax {
		return core.Invalid("coin_reward", "INVALID_NUMBER")
	}
	if in.DiamondReward < 0 || in.DiamondReward > s.Config.Limits.RewardMax {
		return core.Invalid("diamond_reward", "INVALID_NUMBER")
	}
	if in.DailyLimit < 1 || in.DailyLimit > s.Config.Limits.DailyLimitMax {
		return core.Invalid("daily_limit", "INVALID_NUMBER")
	}
	for _, activity := range in.UnlockActivities {
		if activity != "read" && activity != "run" && activity != "ball" {
			return core.Invalid("unlock_activities", "INVALID_VALUE")
		}
	}
	if len(in.Weekdays) == 0 {
		return core.Invalid("weekdays", "REQUIRED")
	}
	for _, day := range in.Weekdays {
		if day < 1 || day > 7 {
			return core.Invalid("weekdays", "INVALID_WEEKDAY")
		}
	}
	return nil
}

// weekdayMask keeps storage compact while preserving Monday-based API weekdays.
func weekdayMask(days []int) int {
	mask := 0
	for _, day := range days {
		mask |= 1 << (day - 1)
	}
	return mask
}

// weekdays expands the configured bit set in stable chronological order.
func weekdays(mask int) []int {
	days := []int{}
	for day := 1; day <= 7; day++ {
		if mask&(1<<(day-1)) != 0 {
			days = append(days, day)
		}
	}
	return days
}

// CreateTask makes one configured task without touching past check-in snapshots.
func (s *Service) CreateTask(ctx context.Context, p account.Principal, key string, in TaskInput) (Task, error) {
	var result Task
	normalizeTask(&in)
	if in.UnlockActivities == nil {
		in.UnlockActivities = []string{}
	}
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	hash, err := idempotency.Hash("task.create", in)
	if err != nil {
		return result, err
	}
	saved, err := idempotency.Lookup(ctx, tx, "task.create", key, hash)
	if err != nil {
		return result, err
	}
	if saved != nil {
		err = json.Unmarshal(saved.JSON, &result)
		if result.UnlockActivities == nil {
			result.UnlockActivities = []string{}
		}
		return result, err
	}
	if err := s.validTask(&in); err != nil {
		return result, err
	}
	if in.CategoryID != nil {
		if _, err := categoryByID(ctx, tx, *in.CategoryID); err != nil {
			return result, err
		}
	}
	result = Task{UnlockActivities: in.UnlockActivities, ID: core.ID(), CategoryID: in.CategoryID, Name: in.Name, IconKey: in.IconKey, CoinReward: in.CoinReward, DiamondReward: in.DiamondReward, DailyLimit: in.DailyLimit, Weekdays: in.Weekdays, Enabled: in.Enabled, Version: 1}
	_, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,category_id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)", result.ID, in.CategoryID, in.Name, in.IconKey, in.CoinReward, in.DiamondReward, in.DailyLimit, weekdayMask(in.Weekdays), in.Enabled, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return result, err
	}
	if err = replaceTaskIslandActivities(ctx, tx, result.ID, in.UnlockActivities); err != nil {
		return result, err
	}
	if err = achievement.RecordSchedule(ctx, tx, result.ID, core.Today(now), weekdayMask(in.Weekdays), in.Enabled); err != nil {
		return result, err
	}
	if err = achievement.Reconcile(ctx, tx, now); err != nil {
		return result, err
	}
	if err = idempotency.Save(ctx, tx, "task.create", key, hash, result.ID, 201, result, now); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// UpdateTask replaces the current rule while leaving every existing record untouched.
func (s *Service) UpdateTask(ctx context.Context, p account.Principal, id string, in TaskInput) (Task, error) {
	var result Task
	normalizeTask(&in)
	if err := s.validTask(&in); err != nil {
		return result, err
	}
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	old, err := taskByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if old.Version != in.ExpectedVersion {
		return result, core.VersionConflict(old.Version)
	}
	if in.CategoryID != nil {
		if _, err := categoryByID(ctx, tx, *in.CategoryID); err != nil {
			return result, err
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE tasks SET category_id=?,name=?,icon_key=?,coin_reward=?,diamond_reward=?,daily_limit=?,weekday_mask=?,enabled=?,version=version+1,updated_at=? WHERE id=?", in.CategoryID, in.Name, in.IconKey, in.CoinReward, in.DiamondReward, in.DailyLimit, weekdayMask(in.Weekdays), in.Enabled, now.UnixMilli(), id)
	if err != nil {
		return result, err
	}
	if in.UnlockActivities != nil {
		if err = replaceTaskIslandActivities(ctx, tx, id, in.UnlockActivities); err != nil {
			return result, err
		}
	}
	if !slices.Equal(old.Weekdays, in.Weekdays) || old.Enabled != in.Enabled {
		if err = achievement.RecordSchedule(ctx, tx, id, core.Today(now), weekdayMask(in.Weekdays), in.Enabled); err != nil {
			return result, err
		}
	}
	if err = achievement.Reconcile(ctx, tx, now); err != nil {
		return result, err
	}
	result, err = taskByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// DeleteTask retains category and schedule history while stopping future task appearances.
func (s *Service) DeleteTask(ctx context.Context, p account.Principal, id string, version int64) error {
	tx, now, err := s.begin(ctx, p, true)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	item, err := taskByID(ctx, tx, id)
	if err != nil {
		return err
	}
	if item.Version != version {
		return core.VersionConflict(item.Version)
	}
	_, err = tx.ExecContext(ctx, "UPDATE tasks SET enabled=0,deleted_at=?,updated_at=?,version=version+1 WHERE id=?", now.UnixMilli(), now.UnixMilli(), id)
	if err != nil {
		return err
	}
	day, _ := core.ParseDate(core.Today(now))
	if err = achievement.RecordSchedule(ctx, tx, id, day.AddDate(0, 0, 1).Format(time.DateOnly), weekdayMask(item.Weekdays), false); err != nil {
		return err
	}
	if err = achievement.Reconcile(ctx, tx, now); err != nil {
		return err
	}
	return tx.Commit()
}

const taskColumns = "id,category_id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,version,(SELECT json_group_array(activity) FROM (SELECT activity FROM task_island_activities WHERE task_id=tasks.id ORDER BY activity))"

// scanner is the shared standard-library Scan shape for single and multiple rows.
type scanner interface{ Scan(...any) error }

// scanTask translates a stored weekday mask into the explicit public array.
func scanTask(row scanner) (Task, error) {
	var t Task
	var mask int
	var activities string
	err := row.Scan(&t.ID, &t.CategoryID, &t.Name, &t.IconKey, &t.CoinReward, &t.DiamondReward, &t.DailyLimit, &mask, &t.Enabled, &t.Version, &activities)
	if err == nil {
		err = json.Unmarshal([]byte(activities), &t.UnlockActivities)
	}
	t.Weekdays = weekdays(mask)
	return t, err
}

// taskByID excludes soft-deleted tasks from mutable configuration reads.
func taskByID(ctx context.Context, tx *sql.Tx, id string) (Task, error) {
	t, err := scanTask(tx.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=? AND deleted_at IS NULL", id))
	if errors.Is(err, sql.ErrNoRows) {
		err = core.Fail(404, "NOT_FOUND")
	}
	return t, err
}

// Tasks allows inactive configuration only through current management authorization.
func (s *Service) Tasks(ctx context.Context, p account.Principal, includeInactive bool) ([]Task, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, p, includeInactive, s.Now()); err != nil {
		return nil, err
	}
	query := "SELECT " + taskColumns + " FROM tasks WHERE deleted_at IS NULL"
	if !includeInactive {
		query += " AND enabled=1"
	}
	query += " ORDER BY name,id"
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}
