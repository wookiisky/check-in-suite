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
	Version    int64        `json:"version"`    // Optimistic concurrency version.
	Placements []Placement  `json:"placements"` // Saved layout, including free objects.
	Inventory  []OwnedItem  `json:"inventory"`  // All owned instances, including stored objects.
	Catalog    []Definition `json:"catalog"`    // Current definitions permit future additive capabilities.
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
	return []Placement{{ID: "base:house", ItemKey: "house", X: -3, Y: -2, Zone: "outdoor"}, {ID: "base:desk", ItemKey: "desk", Zone: "indoor"}, {ID: "base:run", ItemKey: "run", X: 3, Y: 2, Zone: "outdoor"}, {ID: "base:environment", ItemKey: "day", Zone: "outdoor"}}
}
