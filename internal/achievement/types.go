// Package achievement evaluates configured milestones from effective check-in facts.
package achievement

import (
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
)

// Service owns milestone configuration and qualification, sharing caller-owned write transactions.
type Service struct {
	DB       *sql.DB          // Shared application database.
	Accounts *account.Service // Existing session authority.
	Config   config.Config    // Configured text and number limits.
	Now      func() time.Time // Business operation clock.
}

// New binds the milestone service without modifying existing data.
func New(db *sql.DB, accounts *account.Service, cfg config.Config) *Service {
	return &Service{DB: db, Accounts: accounts, Config: cfg, Now: time.Now}
}

// Input contains one fixed metric and its optional historical calendar window.
type Input struct {
	Name       string   `json:"name"`        // Short text identifying the badge.
	AssetKey   string   `json:"asset_key"`   // Immutable built-in badge resource.
	Metric     string   `json:"metric"`      // count, days, streak, coins, or diamonds.
	Scope      string   `json:"scope"`       // all, category, or tasks.
	CategoryID *string  `json:"category_id"` // Current category identity for category scope.
	TaskIDs    []string `json:"task_ids"`    // Stable task identities for explicit scope.
	Target     int64    `json:"target"`      // Required positive progress.
	WindowDays *int     `json:"window_days"` // Optional inclusive consecutive calendar-day window.
	Enabled    bool     `json:"enabled"`     // Whether this rule can grant new qualification.
}

// UpdateInput confirms the configuration version without overwriting qualification fields.
type UpdateInput struct {
	Input                 // Editable definition.
	ExpectedVersion int64 `json:"expected_version"` // Last reviewed configuration version.
}

// Achievement combines the current definition with its persisted qualification and equipment.
type Achievement struct {
	Input                     // Definition used for current qualification.
	ID        string          `json:"id"`        // Stable milestone identity.
	Deleted   bool            `json:"deleted"`   // Archived configuration still retained for historical ownership.
	Version   int64           `json:"version"`   // Optimistic configuration version.
	Progress  int64           `json:"progress"`  // Historical best progress from effective records.
	Qualified bool            `json:"qualified"` // Whether this milestone is currently earned.
	Equipped  bool            `json:"equipped"`  // Whether its badge is visible below the character.
	EarnedAt  *string         `json:"earned_at"` // Latest actual grant time; preserved when qualification is lost.
	Category  *CategoryOption `json:"category"`  // Current retained category details for category scope, otherwise null.
	Tasks     []TaskOption    `json:"tasks"`     // Selected task details, including deleted identities, in task_ids order.
}

// ListResult preserves a non-null list even for an empty new installation.
type ListResult struct {
	Items []Achievement `json:"items"` // Visible definitions and retained qualified badges.
}

// CategoryOption retains deleted category identities for existing rule forms.
type CategoryOption struct {
	ID      string `json:"id"`      // Stable category identity.
	Name    string `json:"name"`    // Current retained display name.
	Deleted bool   `json:"deleted"` // Whether ordinary task configuration hides this category.
}

// TaskOption retains deleted tasks and their final category membership.
type TaskOption struct {
	ID         string  `json:"id"`          // Stable task identity.
	Name       string  `json:"name"`        // Retained current display name.
	CategoryID *string `json:"category_id"` // Current or last category identity.
	Deleted    bool    `json:"deleted"`     // Whether the task was removed from daily use.
}

// OptionsResult supplies complete selection identities without exposing unrelated data.
type OptionsResult struct {
	Categories []CategoryOption `json:"categories"` // Includes historical categories.
	Tasks      []TaskOption     `json:"tasks"`      // Includes deleted tasks.
}
