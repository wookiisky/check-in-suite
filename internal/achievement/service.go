package achievement

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
)

// normalize gives equivalent task sets the same replay identity.
func normalize(input *Input) {
	input.Name = strings.TrimSpace(input.Name)
	input.TaskIDs = slices.Clone(input.TaskIDs)
	slices.Sort(input.TaskIDs)
	input.TaskIDs = slices.Compact(input.TaskIDs)
	if input.TaskIDs == nil {
		input.TaskIDs = []string{}
	}
}

// validate accepts only explicit metric/scope combinations and retained real references.
func (s *Service) validate(ctx context.Context, tx *sql.Tx, input Input) error {
	if err := core.Text("name", input.Name, 1, s.Config.Limits.NameMax); err != nil {
		return err
	}
	if !assets.Valid(input.AssetKey, assets.KindBadge) {
		return core.Invalid("asset_key", "INVALID_ASSET")
	}
	if !slices.Contains([]string{"count", "days", "streak", "coins", "diamonds"}, input.Metric) {
		return core.Invalid("metric", "INVALID_VALUE")
	}
	if input.Target < 1 || input.Target > core.MaxInteger {
		return core.Invalid("target", "INVALID_VALUE")
	}
	if input.WindowDays != nil && (*input.WindowDays < 1 || int64(*input.WindowDays) > core.MaxInteger) {
		return core.Invalid("window_days", "INVALID_VALUE")
	}
	switch input.Scope {
	case "all":
		if input.CategoryID != nil || len(input.TaskIDs) != 0 {
			return core.Invalid("scope", "INVALID_VALUE")
		}
	case "category":
		if input.CategoryID == nil || len(input.TaskIDs) != 0 {
			return core.Invalid("category_id", "INVALID_VALUE")
		}
		if err := exists(ctx, tx, "SELECT id FROM categories WHERE id=?", *input.CategoryID, "category_id"); err != nil {
			return err
		}
	case "tasks":
		if input.CategoryID != nil || len(input.TaskIDs) == 0 {
			return core.Invalid("task_ids", "REQUIRED")
		}
		for _, id := range input.TaskIDs {
			if err := exists(ctx, tx, "SELECT id FROM tasks WHERE id=?", id, "task_ids"); err != nil {
				return err
			}
		}
	default:
		return core.Invalid("scope", "INVALID_VALUE")
	}
	return nil
}

// replaceTasks keeps explicit task selection normalized under foreign-key enforcement.
func replaceTasks(ctx context.Context, tx *sql.Tx, id string, taskIDs []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM achievement_tasks WHERE achievement_id=?", id); err != nil {
		return err
	}
	for _, taskID := range taskIDs {
		if _, err := tx.ExecContext(ctx, "INSERT INTO achievement_tasks(achievement_id,task_id) VALUES(?,?)", id, taskID); err != nil {
			return err
		}
	}
	return nil
}

// Create saves the definition and immediately evaluates existing effective history atomically.
func (s *Service) Create(ctx context.Context, p account.Principal, key string, input Input) (Achievement, error) {
	normalize(&input)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Achievement{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return Achievement{}, err
	}
	hash, err := idempotency.Hash("achievement.create", input)
	if err != nil {
		return Achievement{}, err
	}
	saved, err := idempotency.Lookup(ctx, tx, "achievement.create", key, hash)
	if err != nil {
		return Achievement{}, err
	}
	if saved != nil {
		return readAchievement(ctx, tx, saved.ResourceID)
	}
	if err = s.validate(ctx, tx, input); err != nil {
		return Achievement{}, err
	}
	id := core.ID()
	_, err = tx.ExecContext(ctx, `INSERT INTO achievements(id,name,asset_key,metric,scope,category_id,target,window_days,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, input.Name, input.AssetKey, input.Metric, input.Scope, input.CategoryID, input.Target, input.WindowDays, input.Enabled, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return Achievement{}, err
	}
	if err = replaceTasks(ctx, tx, id, input.TaskIDs); err != nil {
		return Achievement{}, err
	}
	if err = Reconcile(ctx, tx, now); err != nil {
		return Achievement{}, err
	}
	if err = idempotency.Save(ctx, tx, "achievement.create", key, hash, id, 201, json.RawMessage(`{}`), now); err != nil {
		return Achievement{}, err
	}
	item, err := readAchievement(ctx, tx, id)
	if err != nil {
		return item, err
	}
	return item, tx.Commit()
}

// Update applies the reviewed current rule to all history without retaining competing rule snapshots.
func (s *Service) Update(ctx context.Context, p account.Principal, id string, input UpdateInput) (Achievement, error) {
	normalize(&input.Input)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Achievement{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return Achievement{}, err
	}
	current, err := readAchievement(ctx, tx, id)
	if err != nil {
		return current, err
	}
	if current.Deleted {
		return Achievement{}, core.Fail(404, "NOT_FOUND")
	}
	if current.Version != input.ExpectedVersion {
		return Achievement{}, core.VersionConflict(current.Version)
	}
	if err = s.validate(ctx, tx, input.Input); err != nil {
		return Achievement{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE achievements SET name=?,asset_key=?,metric=?,scope=?,category_id=?,target=?,window_days=?,enabled=?,version=version+1,updated_at=? WHERE id=?`, input.Name, input.AssetKey, input.Metric, input.Scope, input.CategoryID, input.Target, input.WindowDays, input.Enabled, now.UnixMilli(), id)
	if err != nil {
		return Achievement{}, err
	}
	if err = replaceTasks(ctx, tx, id, input.TaskIDs); err != nil {
		return Achievement{}, err
	}
	if err = Reconcile(ctx, tx, now); err != nil {
		return Achievement{}, err
	}
	item, err := readAchievement(ctx, tx, id)
	if err != nil {
		return item, err
	}
	return item, tx.Commit()
}

// Delete archives configuration while retaining owned badges and their recalculation criteria.
func (s *Service) Delete(ctx context.Context, p account.Principal, id string, version int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return err
	}
	item, err := readAchievement(ctx, tx, id)
	if err != nil {
		return err
	}
	if item.Deleted {
		return nil
	}
	if item.Version != version {
		return core.VersionConflict(item.Version)
	}
	if _, err = tx.ExecContext(ctx, "UPDATE achievements SET enabled=0,deleted_at=?,updated_at=?,version=version+1 WHERE id=?", now.UnixMilli(), now.UnixMilli(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetEquipped is a repeatable per-badge operation and never equips an unearned milestone.
func (s *Service) SetEquipped(ctx context.Context, p account.Principal, id string, equipped bool) (Achievement, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Achievement{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return Achievement{}, err
	}
	item, err := readAchievement(ctx, tx, id)
	if err != nil {
		return item, err
	}
	if equipped && !item.Qualified {
		return Achievement{}, core.Fail(409, "ACHIEVEMENT_NOT_EARNED")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE achievements SET equipped=? WHERE id=?", equipped, id); err != nil {
		return Achievement{}, err
	}
	item.Equipped = equipped
	return item, tx.Commit()
}
