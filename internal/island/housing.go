package island

import (
	_ "embed"
	"encoding/json"
	"math"
)

// houseRect is a closed ground-space rectangle shared with the SVG floor plan.
type houseRect struct {
	MinX float64 `json:"minX"` // Left edge of the usable ground area.
	MaxX float64 `json:"maxX"` // Right edge of the usable ground area.
	MinY float64 `json:"minY"` // Back edge of the usable ground area.
	MaxY float64 `json:"maxY"` // Front edge of the usable ground area.
}

// houseLayout is the single floor plan consumed by rendering, walking and saved-layout validation.
type houseLayout struct {
	Width         float64   `json:"width"`         // Interior ground width, excluding the external wall volume.
	Depth         float64   `json:"depth"`         // Interior ground depth, excluding the external wall volume.
	WallThickness float64   `json:"wallThickness"` // Thickness reserved for fixed interior partitions.
	WallHeight    float64   `json:"wallHeight"`    // Drawing height; does not affect ground geometry.
	Bathroom      houseRect `json:"bathroom"`      // Bathroom footprint in the expanded back corner.
	BathroomDoor  struct {
		MinX float64 `json:"minX"` // Door opening begins here along the front partition.
		MaxX float64 `json:"maxX"` // Door opening ends here along the front partition.
		Y    float64 `json:"y"`    // Front partition ground coordinate.
	} `json:"bathroomDoor"` // The opening does not reserve a second placement zone.
	Entrance struct {
		X float64 `json:"x"` // Interior side of the house entrance.
		Y float64 `json:"y"` // Interior side of the house entrance.
	} `json:"entrance"` // Shared actor transition and keep-clear point.
	PassageClearance float64 `json:"passageClearance"` // Walking clearance around the house entrance.
}

//go:embed house-layout.json
var houseLayoutJSON []byte

// housingPlan reads the small embedded plan without exposing mutable shared state.
func housingPlan() houseLayout {
	var layout houseLayout
	if err := json.Unmarshal(houseLayoutJSON, &layout); err != nil {
		panic(err)
	}
	return layout
}

// placementSize rotates the rectangular footprint in ground coordinates.
func placementSize(p Placement, d Definition) (float64, float64) {
	if p.Rotation%180 != 0 {
		return d.Depth, d.Width
	}
	return d.Width, d.Depth
}

// overlapsRect excludes a touching edge while protecting the full furniture footprint.
func overlapsRect(p Placement, width, depth float64, r houseRect) bool {
	return p.X+width/2 > r.MinX && p.X-width/2 < r.MaxX && p.Y+depth/2 > r.MinY && p.Y-depth/2 < r.MaxY
}

// interiorPlacementClear prevents crossing fixed partitions or sealing either entrance.
func interiorPlacementClear(p Placement, width, depth float64) bool {
	layout := housingPlan()
	halfWall := layout.WallThickness / 2
	bath, door := layout.Bathroom, layout.BathroomDoor
	obstacles := []houseRect{
		{bath.MinX - halfWall, bath.MinX + halfWall, bath.MinY, bath.MaxY + halfWall},
		{bath.MinX, door.MinX, door.Y - halfWall, door.Y + halfWall},
		{door.MaxX, bath.MaxX, door.Y - halfWall, door.Y + halfWall},
		{door.MinX, door.MaxX, door.Y - .6, door.Y + .6},
		{layout.Entrance.X - layout.PassageClearance, layout.Entrance.X + layout.PassageClearance, layout.Entrance.Y - layout.PassageClearance, layout.Depth / 2},
	}
	for _, obstacle := range obstacles {
		if overlapsRect(p, width, depth, obstacle) {
			return false
		}
	}
	return true
}

// houseDoorClear retains the existing outdoor approach contract after expansion.
func houseDoorClear(house Placement, d Definition, other Placement, item Definition) bool {
	width, depth := placementSize(other, item)
	return math.Abs(other.X-house.X) >= width/2+.3 || math.Abs(other.Y-(house.Y+d.Depth/2+.6)) >= depth/2+.3
}
