package island

import (
	"database/sql"
	"time"
)

// Service persists owned instances independently from portrait equipment.
type Service struct {
	DB  *sql.DB          // Shared application database.
	Now func() time.Time // Authorization clock, injectable in tests.
}

// New uses the existing database without seeding products or mutating schema.
func New(db *sql.DB, now func() time.Time) *Service { return &Service{DB: db, Now: now} }

// Placement is one owned instance positioned in outdoor or indoor ground coordinates.
type Placement struct {
	ID       string  `json:"id"`       // Purchase ID or explicit free base instance ID.
	ItemKey  string  `json:"item_key"` // Stable catalog identity.
	X        float64 `json:"x"`        // Ground horizontal coordinate.
	Y        float64 `json:"y"`        // Ground depth coordinate.
	Rotation int     `json:"rotation"` // Supported quarter-turn object orientation.
	Zone     string  `json:"zone"`     // outdoor or indoor; independent from camera state.
}

// OwnedItem grants a single placeable instance without duplicating purchase accounting.
type OwnedItem struct {
	ID      string `json:"id"`       // Same identity used by its placement.
	ItemKey string `json:"item_key"` // Current capabilities resolved by stable identity.
}

// State is one consistent snapshot of layout, ownership and available capabilities.
type State struct {
	HousingAdjustment *HousingAdjustment `json:"housing_adjustment,omitempty"` // One-time expansion notice until the next successful layout save.
	Version           int64              `json:"version"`                      // Optimistic concurrency version.
	Placements        []Placement        `json:"placements"`                   // Saved layout, including free objects.
	Inventory         []OwnedItem        `json:"inventory"`                    // All owned instances, including stored objects.
	Catalog           []Definition       `json:"catalog"`                      // Current definitions permit future additive capabilities.
	Today             string             `json:"today"`                        // Business date used for this eligibility snapshot.
	ExpiresAt         string             `json:"expires_at"`                   // Next Asia/Taipei midnight; yesterday's access must not survive it.
	ActivityAccess    []ActivityAccess   `json:"activity_access"`              // Current task requirements and eligibility, independent of item capabilities.
}

// ActivityTask names a current requirement while preserving disabled tasks and their valid records.
type ActivityTask struct {
	ID      string `json:"id"`      // Stable task identity, never inferred from its name.
	Name    string `json:"name"`    // Current display name for the locked activity explanation.
	Enabled bool   `json:"enabled"` // Whether the task currently accepts new check-ins.
}

// ActivityAccess describes one activity shared by all items with that capability.
type ActivityAccess struct {
	Activity  string         `json:"activity"`  // Controlled activity identity from the item catalog.
	Available bool           `json:"available"` // True when unrestricted or any linked task has today's valid record.
	Tasks     []ActivityTask `json:"tasks"`     // Undeleted linked tasks; an empty array means unrestricted.
}

// SaveInput replaces the complete layout against a reviewed version.
type SaveInput struct {
	ExpectedVersion int64       `json:"expected_version"` // Last read state version.
	Placements      []Placement `json:"placements"`       // Proposed placement of owned instances.
}

// baseInventory grants the initial home, desk, exercise area and daytime environment.
func baseInventory() []OwnedItem {
	return []OwnedItem{{"base:house", "house"}, {"base:desk", "desk"}, {"base:run", "run"}, {"base:environment", "day"}}
}

// defaultPlacements supplies the first complete scene without writing during reads.
func defaultPlacements() []Placement {
	return []Placement{{ID: "base:house", ItemKey: "house", X: -1.5, Y: -2, Zone: "outdoor"}, {ID: "base:desk", ItemKey: "desk", Zone: "indoor"}, {ID: "base:run", ItemKey: "run", X: 3.25, Y: 4, Zone: "outdoor"}, {ID: "base:environment", ItemKey: "day", Zone: "outdoor"}}
}
