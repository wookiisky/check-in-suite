package achievement

import (
	"context"
	"database/sql"
	"errors"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

const achievementColumns = `id,name,asset_key,metric,scope,category_id,target,window_days,enabled,deleted_at,version,progress,qualified,equipped,earned_at`

// rowScanner covers a row and a cursor without binding model reads to the global connection.
type rowScanner interface{ Scan(...any) error }

// scanAchievement converts nullable database values into explicit API fields.
func scanAchievement(row rowScanner) (Achievement, error) {
	var item Achievement
	var category sql.NullString
	var window, deleted, earned sql.NullInt64
	err := row.Scan(&item.ID, &item.Name, &item.AssetKey, &item.Metric, &item.Scope, &category, &item.Target, &window, &item.Enabled, &deleted, &item.Version, &item.Progress, &item.Qualified, &item.Equipped, &earned)
	item.TaskIDs = []string{}
	item.Tasks = []TaskOption{}
	if category.Valid {
		item.CategoryID = &category.String
	}
	if window.Valid {
		value := int(window.Int64)
		item.WindowDays = &value
	}
	item.Deleted = deleted.Valid
	if earned.Valid {
		value := core.Timestamp(earned.Int64)
		item.EarnedAt = &value
	}
	return item, err
}

// readAchievements reads bound identities and their retained names in the same transaction.
func readAchievements(ctx context.Context, tx *sql.Tx, where string, args ...any) ([]Achievement, error) {
	items := []Achievement{}
	rows, err := tx.QueryContext(ctx, "SELECT "+achievementColumns+" FROM achievements "+where+" ORDER BY created_at,id", args...)
	if err != nil {
		return items, err
	}
	for rows.Next() {
		item, scanErr := scanAchievement(rows)
		if scanErr != nil {
			rows.Close()
			return items, scanErr
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return items, err
	}
	for index := range items {
		if items[index].CategoryID != nil {
			category := &CategoryOption{}
			err = tx.QueryRowContext(ctx, "SELECT id,name,deleted_at IS NOT NULL FROM categories WHERE id=?", *items[index].CategoryID).Scan(&category.ID, &category.Name, &category.Deleted)
			if err != nil {
				return items, err
			}
			items[index].Category = category
		}
		rows, err = tx.QueryContext(ctx, `SELECT t.id,t.name,t.category_id,t.deleted_at IS NOT NULL
			FROM achievement_tasks a JOIN tasks t ON t.id=a.task_id
			WHERE a.achievement_id=? ORDER BY t.id`, items[index].ID)
		if err != nil {
			return items, err
		}
		for rows.Next() {
			var task TaskOption
			if err = rows.Scan(&task.ID, &task.Name, &task.CategoryID, &task.Deleted); err != nil {
				rows.Close()
				return items, err
			}
			items[index].TaskIDs = append(items[index].TaskIDs, task.ID)
			items[index].Tasks = append(items[index].Tasks, task)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return items, err
		}
	}
	return items, nil
}

// readAchievement includes archived definitions for creation replay and retained equipment.
func readAchievement(ctx context.Context, tx *sql.Tx, id string) (Achievement, error) {
	items, err := readAchievements(ctx, tx, "WHERE id=?", id)
	if err != nil {
		return Achievement{}, err
	}
	if len(items) == 0 {
		return Achievement{}, core.Fail(404, "NOT_FOUND")
	}
	return items[0], nil
}

// List authorizes management-only configuration inside its consistent read snapshot.
func (s *Service) List(ctx context.Context, p account.Principal, management bool) (ListResult, error) {
	result := ListResult{Items: []Achievement{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, management, s.Now()); err != nil {
		return result, err
	}
	where := "WHERE (enabled=1 AND deleted_at IS NULL) OR qualified=1"
	if management {
		where = "WHERE deleted_at IS NULL OR qualified=1"
	}
	result.Items, err = readAchievements(ctx, tx, where)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// ReadEquipped shares the camp transaction so qualification and badge display cannot disagree.
func ReadEquipped(ctx context.Context, tx *sql.Tx) ([]Achievement, error) {
	return readAchievements(ctx, tx, "WHERE qualified=1 AND equipped=1")
}

// Options lists retained selection identities under current management authorization.
func (s *Service) Options(ctx context.Context, p account.Principal) (OptionsResult, error) {
	result := OptionsResult{Categories: []CategoryOption{}, Tasks: []TaskOption{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, true, s.Now()); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,name,deleted_at IS NOT NULL FROM categories ORDER BY name,id")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var item CategoryOption
		if err = rows.Scan(&item.ID, &item.Name, &item.Deleted); err != nil {
			rows.Close()
			return result, err
		}
		result.Categories = append(result.Categories, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,name,category_id,deleted_at IS NOT NULL FROM tasks ORDER BY name,id")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var item TaskOption
		if err = rows.Scan(&item.ID, &item.Name, &item.CategoryID, &item.Deleted); err != nil {
			rows.Close()
			return result, err
		}
		result.Tasks = append(result.Tasks, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// exists checks stable references without requiring historical entities to remain active.
func exists(ctx context.Context, tx *sql.Tx, query string, id, field string) error {
	var found string
	err := tx.QueryRowContext(ctx, query, id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Invalid(field, "INVALID_VALUE")
	}
	return err
}
