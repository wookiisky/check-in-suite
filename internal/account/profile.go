package account

import (
	"context"
	"database/sql"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// readAccount reads the single public profile through its caller's transaction.
func readAccount(ctx context.Context, tx *sql.Tx) (Account, error) {
	var a Account
	err := tx.QueryRowContext(ctx, "SELECT id,username,display_name,version,music_enabled,effects_enabled,reduce_motion FROM accounts WHERE id=1").Scan(&a.ID, &a.Username, &a.DisplayName, &a.Version, &a.Preferences.MusicEnabled, &a.Preferences.EffectsEnabled, &a.Preferences.ReduceMotion)
	return a, err
}

// UpdateProfile edits only the display name after management and optimistic-version checks.
func (s *Service) UpdateProfile(ctx context.Context, p Principal, name string, version int64) (Account, error) {
	name = strings.TrimSpace(name)
	if err := core.Text("display_name", name, 1, s.Config.Limits.NameMax); err != nil {
		return Account{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, true, now); err != nil {
		return Account{}, err
	}
	a, err := readAccount(ctx, tx)
	if err != nil {
		return Account{}, err
	}
	if a.Version != version {
		return Account{}, core.VersionConflict(a.Version)
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET display_name=?,version=version+1,updated_at=? WHERE id=1", name, now.UnixMilli()); err != nil {
		return Account{}, err
	}
	a.DisplayName = name
	a.Version++
	if err = tx.Commit(); err != nil {
		return Account{}, err
	}
	return a, nil
}

// UpdatePreferences changes specified fields only and leaves profile version untouched.
func (s *Service) UpdatePreferences(ctx context.Context, p Principal, patch PreferencesPatch) (Preferences, error) {
	if patch.MusicEnabled == nil && patch.EffectsEnabled == nil && patch.ReduceMotion == nil {
		return Preferences{}, core.Invalid("preferences", "REQUIRED")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Preferences{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, false, now); err != nil {
		return Preferences{}, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET music_enabled=coalesce(?,music_enabled),effects_enabled=coalesce(?,effects_enabled),reduce_motion=coalesce(?,reduce_motion),updated_at=? WHERE id=1", patch.MusicEnabled, patch.EffectsEnabled, patch.ReduceMotion, now.UnixMilli()); err != nil {
		return Preferences{}, err
	}
	a, err := readAccount(ctx, tx)
	if err != nil {
		return Preferences{}, err
	}
	if err = tx.Commit(); err != nil {
		return Preferences{}, err
	}
	return a.Preferences, nil
}
