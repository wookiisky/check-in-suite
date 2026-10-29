package checkin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
	"github.com/wookiisky/check-in-suite/internal/media"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

const recordColumns = "id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,text,photo_media_id,audio_media_id,source,deleted_at,version,created_at,updated_at"

// receipt deliberately excludes private content, media and credentials from durable replay storage.
type receipt struct {
	CheckinID     string         `json:"checkin_id"`     // Identity returned by the original command.
	Wallet        wallet.Balance `json:"wallet"`         // Immutable economic result of that command.
	TaskRemaining int64          `json:"task_remaining"` // Original remaining allowance.
	Today         string         `json:"today"`          // Original server date.
}

// scanRecord preserves actual instants and an explicit deletion flag for recovered commands.
func scanRecord(row scanner) (Record, error) {
	var r Record
	var deleted sql.NullInt64
	var created, updated int64
	err := row.Scan(&r.ID, &r.TaskID, &r.BusinessDate, &r.TaskNameSnapshot, &r.TaskIconSnapshot, &r.CoinRewardSnapshot, &r.DiamondRewardSnapshot, &r.Text, &r.PhotoMediaID, &r.AudioMediaID, &r.Source, &deleted, &r.Version, &created, &updated)
	r.Deleted = deleted.Valid
	r.CreatedAt = core.Timestamp(created)
	r.UpdatedAt = core.Timestamp(updated)
	return r, err
}

// recordByID includes deleted facts only so old commands can be recovered without resurrection.
func recordByID(ctx context.Context, tx *sql.Tx, id string) (Record, error) {
	r, err := scanRecord(tx.QueryRowContext(ctx, "SELECT "+recordColumns+" FROM checkins WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		err = core.Fail(404, "NOT_FOUND")
	}
	return r, err
}

// withActions derives ordinary-entry actions from the response's one server date.
func withActions(record Record, today string) Record {
	record.CanEdit = !record.Deleted && record.BusinessDate == today
	record.CanDelete = record.CanEdit
	return record
}

// Create atomically checks allowance, records its snapshot and grants exactly one reward.
func (s *Service) Create(ctx context.Context, p account.Principal, management bool, key string, in CreateInput) (CreateResult, error) {
	var result CreateResult
	if (management && in.ExpectedToday != "") || (!management && in.BusinessDate != "") {
		return result, core.Invalid("business_date", "INVALID_FIELD")
	}
	tx, now, err := s.begin(ctx, p, management)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	operation := "checkin.create"
	if management {
		operation = "checkin.backfill"
	}
	hash, err := idempotency.Hash(operation, in)
	if err != nil {
		return result, err
	}
	saved, err := idempotency.Lookup(ctx, tx, operation, key, hash)
	if err != nil {
		return result, err
	}
	if saved != nil {
		var original receipt
		if err = json.Unmarshal(saved.JSON, &original); err != nil {
			return result, err
		}
		current, err := recordByID(ctx, tx, original.CheckinID)
		return CreateResult{Checkin: withActions(current, core.Today(now)), Wallet: original.Wallet, TaskRemaining: original.TaskRemaining, Today: original.Today}, err
	}
	if err := core.Text("text", in.Text, 0, s.Config.Limits.TextMax); err != nil {
		return result, err
	}
	today := core.Today(now)
	date := today
	source := "today"
	if management {
		date = in.BusinessDate
		source = "backfill"
	} else if in.ExpectedToday != today {
		return result, core.Fail(409, "DAY_CHANGED")
	}
	parsed, err := core.ParseDate(date)
	if err != nil {
		return result, err
	}
	if date > today {
		return result, core.Fail(422, "FUTURE_DATE")
	}
	task, err := taskByID(ctx, tx, in.TaskID)
	if err != nil {
		return result, err
	}
	if !task.Enabled {
		return result, core.Fail(409, "TASK_UNAVAILABLE")
	}
	if task.Version != in.ExpectedTaskVersion {
		failure := core.Fail(409, "TASK_CHANGED")
		failure.CurrentVersion = &task.Version
		return result, failure
	}
	weekday := int(parsed.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	if !slices.Contains(task.Weekdays, weekday) {
		return result, core.Fail(409, "TASK_UNAVAILABLE")
	}
	var used int64
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM checkins WHERE task_id=? AND business_date=? AND deleted_at IS NULL", task.ID, date).Scan(&used); err != nil {
		return result, err
	}
	if used >= task.DailyLimit {
		return result, core.Fail(409, "DAILY_LIMIT_REACHED")
	}
	if err := media.Replace(ctx, tx, media.References{}, media.References{PhotoID: in.PhotoMediaID, AudioID: in.AudioMediaID}, now, s.Config.MediaOrphanTTL); err != nil {
		return result, err
	}
	id := core.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,text,photo_media_id,audio_media_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, task.ID, date, task.Name, task.IconKey, task.CoinReward, task.DiamondReward, in.Text, in.PhotoMediaID, in.AudioMediaID, source, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return result, err
	}
	balance, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.CheckinGrant, ResourceID: id, Coins: task.CoinReward, Diamonds: task.DiamondReward, At: now})
	if err != nil {
		return result, err
	}
	if err = achievement.ExtendInitialSchedule(ctx, tx, task.ID, date); err != nil {
		return result, err
	}
	if err = achievement.Reconcile(ctx, tx, now); err != nil {
		return result, err
	}
	record, err := recordByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	result = CreateResult{Checkin: withActions(record, today), Wallet: balance, TaskRemaining: task.DailyLimit - used - 1, Today: today}
	original := receipt{CheckinID: id, Wallet: balance, TaskRemaining: result.TaskRemaining, Today: today}
	if err = idempotency.Save(ctx, tx, operation, key, hash, id, 201, original, now); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	slog.InfoContext(ctx, "打卡创建成功", "request_id", core.RequestID(ctx), "checkin_id", id, "task_id", task.ID)
	return result, nil
}

// recordAccess applies route-fixed date permission before checking optimistic content versions.
func recordAccess(record Record, management bool, version int64, now time.Time) error {
	if !management && record.BusinessDate != core.Today(now) {
		return core.Fail(403, "HISTORY_READ_ONLY")
	}
	if !record.Deleted && record.Version != version {
		return core.VersionConflict(record.Version)
	}
	return nil
}

// Edit changes only content and never rewrites reward snapshots or releases a daily slot.
func (s *Service) Edit(ctx context.Context, p account.Principal, management bool, id string, in EditInput) (Record, error) {
	var result Record
	if err := core.Text("text", in.Text, 0, s.Config.Limits.TextMax); err != nil {
		return result, err
	}
	tx, now, err := s.begin(ctx, p, management)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	result, err = recordByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if err := recordAccess(result, management, in.ExpectedVersion, now); err != nil {
		return result, err
	}
	if result.Deleted {
		return result, core.Fail(404, "NOT_FOUND")
	}
	if err := media.Replace(ctx, tx, media.References{PhotoID: result.PhotoMediaID, AudioID: result.AudioMediaID}, media.References{PhotoID: in.PhotoMediaID, AudioID: in.AudioMediaID}, now, s.Config.MediaOrphanTTL); err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE checkins SET text=?,photo_media_id=?,audio_media_id=?,version=version+1,updated_at=? WHERE id=?", in.Text, in.PhotoMediaID, in.AudioMediaID, now.UnixMilli(), id)
	if err != nil {
		return result, err
	}
	result, err = recordByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	return withActions(result, core.Today(now)), tx.Commit()
}

// Delete revokes the historical reward even when spending has already made the balance insufficient.
func (s *Service) Delete(ctx context.Context, p account.Principal, management bool, id string, version int64) (DeleteResult, error) {
	result := DeleteResult{ID: id, Deleted: true}
	tx, now, err := s.begin(ctx, p, management)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	record, err := recordByID(ctx, tx, id)
	if err != nil {
		return result, err
	}
	// Recover a committed deletion across midnight; date checks constrain new changes only.
	if record.Deleted {
		result.Wallet, err = wallet.Get(ctx, tx)
		return result, err
	}
	if err := recordAccess(record, management, version, now); err != nil {
		return result, err
	}
	if err := media.Replace(ctx, tx, media.References{PhotoID: record.PhotoMediaID, AudioID: record.AudioMediaID}, media.References{}, now, s.Config.MediaOrphanTTL); err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE checkins SET text='',photo_media_id=NULL,audio_media_id=NULL,deleted_at=?,updated_at=?,version=version+1 WHERE id=?", now.UnixMilli(), now.UnixMilli(), id)
	if err != nil {
		return result, err
	}
	result.Wallet, err = wallet.Apply(ctx, tx, wallet.Event{Type: wallet.CheckinRevoke, ResourceID: id, Coins: -record.CoinRewardSnapshot, Diamonds: -record.DiamondRewardSnapshot, At: now})
	if err != nil {
		return result, err
	}
	if err = achievement.Reconcile(ctx, tx, now); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	slog.InfoContext(ctx, "打卡删除成功", "request_id", core.RequestID(ctx), "checkin_id", id)
	return result, nil
}
