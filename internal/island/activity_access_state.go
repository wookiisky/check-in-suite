package island

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// ActivityAccessState is an independent task qualification snapshot, never a layout revision.
type ActivityAccessState struct {
	Today          string           `json:"today"`           // Taipei business date used for eligibility.
	ExpiresAt      string           `json:"expires_at"`      // Next Taipei midnight, exclusive.
	ActivityAccess []ActivityAccess `json:"activity_access"` // All supported task-based activities.
}

// readActivityAccessState uses the same transaction and instant for every qualification field.
func readActivityAccessState(ctx context.Context, tx *sql.Tx, accountID int64, now time.Time) (ActivityAccessState, error) {
	zone, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		return ActivityAccessState{}, err
	}
	local := now.In(zone)
	state := ActivityAccessState{
		Today:     core.Today(now),
		ExpiresAt: time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, zone).Format(time.RFC3339),
	}
	state.ActivityAccess, err = readActivityAccess(ctx, tx, accountID, state.Today)
	return state, err
}

// ReadActivityAccess authenticates and reads qualifications without consulting layout or inventory.
func (s *Service) ReadActivityAccess(ctx context.Context, p account.Principal) (ActivityAccessState, error) {
	accountID := p.AccountID
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ActivityAccessState{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return ActivityAccessState{}, err
	}
	state, err := readActivityAccessState(ctx, tx, accountID, now)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

// ActivityTask names a current requirement while preserving disabled tasks and their valid records.
type ActivityTask struct {
	ID      string `json:"id"`      // Stable task identity, never inferred from its name.
	Name    string `json:"name"`    // Current display name for the locked activity explanation.
	Enabled bool   `json:"enabled"` // Whether the task currently accepts new check-ins.
}

// ActivityAccess describes one activity shared by all items with that capability.
type ActivityAccess struct {
	Activity  string         `json:"activity"`  // Controlled business activity identity, independent of geometry.
	Available bool           `json:"available"` // True when unrestricted or any linked task has today's valid record.
	Tasks     []ActivityTask `json:"tasks"`     // Undeleted linked tasks; an empty array means unrestricted.
}
