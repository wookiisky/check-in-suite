// Package checkin owns household task configuration and immutable reward snapshots.
package checkin

import (
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// Service uses explicit transactions and the same authorization rules as account operations.
type Service struct {
	DB       *sql.DB          // Application database; never accessed while a transaction is active.
	Accounts *account.Service // Shared authentication service.
	Config   config.Config    // Confirmed input limits.
	Now      func() time.Time // Fixed once inside each mutation's transaction.
}

// New constructs the task service without creating schema or sample data.
func New(db *sql.DB, accounts *account.Service, cfg config.Config) *Service {
	return &Service{DB: db, Accounts: accounts, Config: cfg, Now: time.Now}
}

// Category groups tasks while preserving their independent identities.
type Category struct {
	ID        string `json:"id"`         // Stable category identity.
	Name      string `json:"name"`       // Trimmed display name.
	SortOrder int64  `json:"sort_order"` // Stable user-facing ordering.
	Version   int64  `json:"version"`    // Optimistic edit version.
}

// CategoryInput describes a category creation or replacement.
type CategoryInput struct {
	Name            string `json:"name"`                       // Required trimmed display name.
	SortOrder       int64  `json:"sort_order"`                 // Requested ordering.
	ExpectedVersion int64  `json:"expected_version,omitempty"` // Required for edits only.
}

// Task is the currently configured rule for future check-ins.
type Task struct {
	ID            string  `json:"id"`             // Stable task identity retained after soft deletion.
	CategoryID    *string `json:"category_id"`    // Optional category; deletion clears this reference.
	Name          string  `json:"name"`           // Display name used by future snapshots.
	IconKey       string  `json:"icon_key"`       // Versioned controlled icon key.
	CoinReward    int64   `json:"coin_reward"`    // Nonnegative reward per new record.
	DiamondReward int64   `json:"diamond_reward"` // Nonnegative reward per new record.
	DailyLimit    int64   `json:"daily_limit"`    // Maximum effective records on an eligible date.
	Weekdays      []int   `json:"weekdays"`       // Monday is one and Sunday is seven.
	Enabled       bool    `json:"enabled"`        // Whether new records may be made.
	Version       int64   `json:"version"`        // Confirmation version for new records.
}

// TaskInput replaces mutable task configuration without modifying past rewards.
type TaskInput struct {
	CategoryID      *string `json:"category_id"`                // Null leaves a task ungrouped.
	Name            string  `json:"name"`                       // Required display name.
	IconKey         string  `json:"icon_key"`                   // Controlled icon identity.
	CoinReward      int64   `json:"coin_reward"`                // Nonnegative coin amount.
	DiamondReward   int64   `json:"diamond_reward"`             // Nonnegative diamond amount.
	DailyLimit      int64   `json:"daily_limit"`                // Positive limit.
	Weekdays        []int   `json:"weekdays"`                   // Nonempty set of weekdays.
	Enabled         bool    `json:"enabled"`                    // Future-record eligibility.
	ExpectedVersion int64   `json:"expected_version,omitempty"` // Required for an edit.
}

// Record retains its original date, identity and rewards during content edits.
type Record struct {
	ID                    string  `json:"id"`                      // Immutable record identity.
	TaskID                string  `json:"task_id"`                 // Stable source task.
	BusinessDate          string  `json:"business_date"`           // Taipei calendar date.
	TaskNameSnapshot      string  `json:"task_name_snapshot"`      // Name when reward was granted.
	TaskIconSnapshot      string  `json:"task_icon_snapshot"`      // Persistent asset identity.
	CoinRewardSnapshot    int64   `json:"coin_reward_snapshot"`    // Original grant and revocation basis.
	DiamondRewardSnapshot int64   `json:"diamond_reward_snapshot"` // Original grant and revocation basis.
	Text                  string  `json:"text"`                    // Mutable private content, cleared on deletion.
	PhotoMediaID          *string `json:"photo_media_id"`          // Optional exclusive photograph.
	AudioMediaID          *string `json:"audio_media_id"`          // Optional exclusive audio recording.
	Source                string  `json:"source"`                  // today or backfill.
	Deleted               bool    `json:"deleted"`                 // Allows old command recovery to report subsequent deletion.
	CanEdit               bool    `json:"can_edit"`                // Ordinary entry may edit only effective records belonging to today.
	CanDelete             bool    `json:"can_delete"`              // Ordinary entry may delete only effective records belonging to today.
	Version               int64   `json:"version"`                 // Content version.
	CreatedAt             string  `json:"created_at"`              // Actual creation instant, including backfills.
	UpdatedAt             string  `json:"updated_at"`              // Last content mutation.
}

// CreateInput distinguishes the route-fixed ordinary date from a management backfill date.
type CreateInput struct {
	TaskID              string  `json:"task_id"`                  // Task confirmed by the user.
	ExpectedToday       string  `json:"expected_today,omitempty"` // Ordinary route's expected current date.
	BusinessDate        string  `json:"business_date,omitempty"`  // Management route's selected date.
	ExpectedTaskVersion int64   `json:"expected_task_version"`    // Confirmed reward configuration.
	Text                string  `json:"text"`                     // Optional text.
	PhotoMediaID        *string `json:"photo_media_id"`           // Validated media to associate.
	AudioMediaID        *string `json:"audio_media_id"`           // Validated media to associate.
}

// EditInput replaces content only; no field can change the original reward or date.
type EditInput struct {
	ExpectedVersion int64   `json:"expected_version"` // Previously displayed record version.
	Text            string  `json:"text"`             // Replacement plain text.
	PhotoMediaID    *string `json:"photo_media_id"`   // Replacement or retained photograph.
	AudioMediaID    *string `json:"audio_media_id"`   // Replacement or retained audio.
}

// CreateResult combines the original economic receipt with current record content on replay.
type CreateResult struct {
	Checkin       Record         `json:"checkin"`        // Current record, possibly edited or deleted after original success.
	Wallet        wallet.Balance `json:"wallet"`         // Balance immediately after the original successful command.
	TaskRemaining int64          `json:"task_remaining"` // Allowance immediately after original success.
	Today         string         `json:"today"`          // Original command's server date.
}

// DeleteResult confirms one revocation and supplies the resulting current balance.
type DeleteResult struct {
	ID      string         `json:"id"`      // Deleted record.
	Deleted bool           `json:"deleted"` // Always true after successful deletion.
	Wallet  wallet.Balance `json:"wallet"`  // Current balance including the revocation.
}

// AvailableTask augments a configured task with its remaining allowance for today.
type AvailableTask struct {
	Task            // Stable API task properties.
	Remaining int64 `json:"remaining"` // Today-only remaining allowance.
}

// Camp is read from one SQLite snapshot, even while another connection commits a write.
type Camp struct {
	Today             string          `json:"today"`               // Taipei date used for every eligibility decision.
	ServerNow         string          `json:"server_now"`          // Single instant for the response.
	Timezone          string          `json:"timezone"`            // Fixed site timezone.
	Tasks             []AvailableTask `json:"tasks"`               // Eligible tasks with remaining allowance.
	Categories        []Category      `json:"categories"`          // Current category choices.
	Wallet            wallet.Balance  `json:"wallet"`              // Same-snapshot spendable balance.
	Account           account.Account `json:"account"`             // Same-snapshot household profile and preferences.
	HasScheduledTasks bool            `json:"has_scheduled_tasks"` // Distinguishes no schedule from all completed.
	Equipment         shop.Equipment  `json:"equipment"`           // Same-snapshot equipped ownership.
}

// RecordPage declares whether more records remain instead of silently truncating a date range.
type RecordPage struct {
	Items      []Record `json:"items"`       // Effective records in stable date/time/ID order.
	NextCursor *string  `json:"next_cursor"` // Null only when the result is complete.
}
