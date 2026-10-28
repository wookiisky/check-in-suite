// Package account owns the single household account and revocable authorization.
package account

import (
	"database/sql"
	"sync"
	"time"

	"github.com/wookiisky/check-in-suite/internal/config"
)

// Principal carries session identity, never a browser-supplied authorization flag.
type Principal struct {
	SessionID         string // Persisted random session identifier.
	CredentialVersion int64  // Credential version observed during authentication.
	CSRFToken         string // Independent request forgery token.
}

// Preferences contains independently writable household settings.
type Preferences struct {
	MusicEnabled   bool `json:"music_enabled"`   // Background music requires an explicit opt-in.
	EffectsEnabled bool `json:"effects_enabled"` // Whether short success sounds may play.
	ReduceMotion   bool `json:"reduce_motion"`   // Household preference in addition to OS settings.
}

// PreferencesPatch contains only the preference fields being changed.
type PreferencesPatch struct {
	MusicEnabled   *bool `json:"music_enabled,omitempty"`   // Nil preserves current music setting.
	EffectsEnabled *bool `json:"effects_enabled,omitempty"` // Nil preserves current effects setting.
	ReduceMotion   *bool `json:"reduce_motion,omitempty"`   // Nil preserves current motion setting.
}

// Account is the public profile; credential and equipment versions are separate.
type Account struct {
	ID          int64       `json:"id"`           // The only account ID is one.
	Username    string      `json:"username"`     // Immutable login identifier.
	DisplayName string      `json:"display_name"` // Household-editable display name.
	Version     int64       `json:"version"`      // Optimistic version for profile edits only.
	Preferences Preferences `json:"preferences"`  // Independently updated sound and motion settings.
}

// Session provides the browser's trusted time, limits and current account state.
type Session struct {
	Account             Account       `json:"account"`               // Public account profile.
	CSRFToken           string        `json:"csrf_token"`            // Token required alongside the authentication cookie on mutations.
	ManagementExpiresAt *string       `json:"management_expires_at"` // Null when locked or expired.
	ServerNow           string        `json:"server_now"`            // RFC3339 current server instant.
	Today               string        `json:"today"`                 // Current Asia/Taipei business date.
	Timezone            string        `json:"timezone"`              // Always Asia/Taipei.
	Limits              config.Limits `json:"limits"`                // Actual configured server limits.
}

// Service binds account operations to the one database and an injectable business clock.
type Service struct {
	DB       *sql.DB                      // Application-owned SQLite connection pool.
	Config   config.Config                // Validated runtime configuration.
	Now      func() time.Time             // Clock read once after acquiring each write transaction.
	verify   func(string, string) bool    // Password verifier, replaceable only by same-package tests.
	hash     func(string) (string, error) // Password derivation, sharing the verification work limit.
	work     chan struct{}                // One expensive password calculation per application service.
	mu       sync.Mutex                   // Protects the small fixed set of authentication rate buckets.
	attempts map[string]attemptWindow     // Fixed login and management failure windows.
}

// attemptWindow tracks authentication failures without storing supplied passwords or names.
type attemptWindow struct {
	Count int       // Failed attempts during this minute.
	Until time.Time // Window expiry; requests may retry afterward.
}

// New constructs an account service with production hashing and a real clock.
func New(db *sql.DB, cfg config.Config) *Service {
	return &Service{DB: db, Config: cfg, Now: time.Now, verify: verifyPassword, hash: hashPassword, work: make(chan struct{}, 1), attempts: map[string]attemptWindow{}}
}
