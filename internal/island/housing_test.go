package island

import "testing"

// TestHousingInterior validates real furniture footprints against the expanded floor and fixed walls.
func TestHousingInterior(t *testing.T) {
	for _, tc := range []struct {
		name     string  // Placement boundary being exercised.
		x, y     float64 // Desk centre in indoor coordinates.
		rotation int     // Quarter-turn footprint orientation.
		valid    bool    // Whether the full footprint remains usable.
	}{
		{"expanded sleeping area", -3.75, -2.5, 0, true},
		{"edge touches floor", -5.3, 1, 0, true},
		{"outside floor", -5.5, 1, 0, false},
		{"bathroom left partition", 2.25, -2, 0, false},
		{"bathroom front partition", 2.5, -1, 0, false},
		{"bathroom doorway", 3.6, -1, 0, false},
		{"bathroom doorway approach", 3.6, -.5, 0, false},
		{"house entrance", 0, 3.5, 0, false},
		{"bathroom interior", 3.5, -2.75, 0, true},
		{"expanded bathroom interior", 5.25, -2.75, 0, true},
		{"rotated floor overflow", -5.75, 1, 90, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			placements := defaultPlacements()
			placements[1].X, placements[1].Y, placements[1].Rotation = tc.x, tc.y, tc.rotation
			err := validatePlacements(placements, State{Inventory: baseInventory(), Placements: defaultPlacements()})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, err=%v", tc.valid, err)
			}
		})
	}
}

// TestHousingExteriorProtectsDecorations reserves the entire eaves and porch footprint at world edges.
func TestHousingExteriorProtectsDecorations(t *testing.T) {
	for _, tc := range []struct {
		name  string  // Exterior boundary or entrance condition.
		x, y  float64 // House centre in outdoor ground coordinates.
		valid bool    // Whether both the exterior envelope and entrance fit.
	}{
		{"default porch clearance", -1.5, -2, true},
		{"left footprint touches edge", -1.5, 0, true},
		{"right footprint touches edge", 1.5, 0, true},
		{"left eaves outside scene", -1.75, 0, false},
		{"right eaves outside scene", 1.75, 0, false},
		{"back footprint touches edge", 0, -3.5, true},
		{"back eaves outside scene", 0, -3.75, false},
		{"entrance inside scene", 0, 2.25, true},
		{"entrance outside scene", 0, 2.5, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			placements := defaultPlacements()
			placements[0].X, placements[0].Y = tc.x, tc.y
			err := validatePlacements(placements, State{Inventory: baseInventory(), Placements: defaultPlacements()})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}
