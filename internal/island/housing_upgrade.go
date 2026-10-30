package island

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
)

// HousingAdjustment reports only objects changed by the one-time home expansion.
type HousingAdjustment struct {
	Moved  int `json:"moved"`  // Existing instances moved to the nearest available position.
	Stored int `json:"stored"` // Existing instances removed from layout but retained in inventory.
}

// currentHousingRevision identifies the 13×9 exterior; revision 1 used 10×8 and no marker used 8×6.
const currentHousingRevision = 2

// UpgradeHousing applies pending home expansion before serving, with its layout and notice in one transaction.
func UpgradeHousing(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previousRevision int
	var previousAdjustment HousingAdjustment
	err = tx.QueryRowContext(ctx, "SELECT revision,moved,stored FROM island_housing_upgrade WHERE id=1").Scan(&previousRevision, &previousAdjustment.Moved, &previousAdjustment.Stored)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if previousRevision >= currentHousingRevision {
		return tx.Commit()
	}
	var version int64
	var raw string
	err = tx.QueryRowContext(ctx, "SELECT version,placements FROM island_state WHERE id=1").Scan(&version, &raw)
	adjustment := HousingAdjustment{}
	if err == nil {
		var placements []Placement
		if err := json.Unmarshal([]byte(raw), &placements); err != nil {
			return err
		}
		placements, adjustment, err = expandedPlacements(placements, previousRevision)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(placements)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE island_state SET version=?,placements=? WHERE id=1", version+1, string(encoded)); err != nil {
			return err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO island_housing_upgrade(id,revision,moved,stored) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,moved=excluded.moved,stored=excluded.stored", currentHousingRevision, previousAdjustment.Moved+adjustment.Moved, previousAdjustment.Stored+adjustment.Stored); err != nil {
		return err
	}
	return tx.Commit()
}

// expandedPlacements keeps old indoor coordinates and changes only conflicts created by expansion.
func expandedPlacements(saved []Placement, previousRevision int) ([]Placement, HousingAdjustment, error) {
	placements := append([]Placement(nil), saved...)
	adjustment := HousingAdjustment{}
	houseIndex := -1
	for index, p := range placements {
		if d, ok := Find(p.ItemKey); ok && d.Category == "house" {
			if houseIndex != -1 {
				return nil, adjustment, fmt.Errorf("housing upgrade requires one house")
			}
			houseIndex = index
		}
	}
	if houseIndex == -1 {
		return nil, adjustment, fmt.Errorf("housing upgrade requires one house")
	}
	oldHouse := placements[houseIndex]
	house := oldHouse
	definition, _ := Find(house.ItemKey)
	house.X = math.Max(-8+definition.Width/2, math.Min(8-definition.Width/2, house.X))
	house.Y = math.Max(-8+definition.Depth/2, math.Min(math.Floor((7.5-definition.Depth/2-.6)*4)/4, house.Y))
	placements[houseIndex] = house
	if house != oldHouse {
		adjustment.Moved++
	}
	oldDefinition := definition
	oldDefinition.Width, oldDefinition.Depth = 8, 6
	if previousRevision == 1 {
		oldDefinition.Width, oldDefinition.Depth = 10, 8
	}
	result := make([]Placement, 0, len(placements))
	for index, p := range placements {
		item, ok := Find(p.ItemKey)
		if !ok {
			return nil, adjustment, fmt.Errorf("unknown saved housing item %q", p.ItemKey)
		}
		if index == houseIndex || p.Zone != "outdoor" || item.Category == "environment" || item.Category == "creature" {
			result = append(result, p)
			continue
		}
		// Preserve historical overlaps; only a newly covered footprint or newly blocked entrance moves.
		newOverlap := placementsOverlap(house, definition, p, item) && !placementsOverlap(oldHouse, oldDefinition, p, item)
		newDoorBlock := !houseDoorClear(house, definition, p, item) && houseDoorClear(oldHouse, oldDefinition, p, item)
		if !newOverlap && !newDoorBlock {
			result = append(result, p)
			continue
		}
		moved, found := nearestHousingPosition(p, item, placements, house, definition)
		if found {
			placements[index] = moved
			result = append(result, moved)
			adjustment.Moved++
		} else {
			// Inventory derives from purchases; omitting a placement cannot remove ownership.
			placements[index].Zone = "stored"
			adjustment.Stored++
		}
	}
	return result, adjustment, nil
}

// placementsOverlap uses the existing client spacing between solid floor footprints.
func placementsOverlap(a Placement, ad Definition, b Placement, bd Definition) bool {
	aw, ah := placementSize(a, ad)
	bw, bh := placementSize(b, bd)
	return math.Abs(a.X-b.X) < (aw+bw)/2+.15 && math.Abs(a.Y-b.Y) < (ah+bh)/2+.15
}

// nearestHousingPosition checks a finite quarter-grid in distance order, with stable tie ordering.
func nearestHousingPosition(original Placement, item Definition, placements []Placement, house Placement, houseDefinition Definition) (Placement, bool) {
	width, depth := placementSize(original, item)
	minX, maxX := int(math.Ceil((-8+width/2)*4)), int(math.Floor((8-width/2)*4))
	minY, maxY := int(math.Ceil((-8+depth/2)*4)), int(math.Floor((8-depth/2)*4))
	if item.Activity != "" {
		maxY = int(math.Floor((7.5 - depth/2 - .6) * 4))
	}
	candidates := make([]Placement, 0, (maxX-minX+1)*(maxY-minY+1))
	for x := minX; x <= maxX; x++ {
		for y := minY; y <= maxY; y++ {
			candidate := original
			candidate.X, candidate.Y = float64(x)/4, float64(y)/4
			candidates = append(candidates, candidate)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		return math.Pow(a.X-original.X, 2)+math.Pow(a.Y-original.Y, 2) < math.Pow(b.X-original.X, 2)+math.Pow(b.Y-original.Y, 2)
	})
	definitions := make(map[string]Definition)
	for _, definition := range Catalog() {
		definitions[definition.Key] = definition
	}
	for _, candidate := range candidates {
		if !houseDoorClear(house, houseDefinition, candidate, item) {
			continue
		}
		clear := true
		for _, other := range placements {
			otherDefinition, ok := definitions[other.ItemKey]
			if other.ID == original.ID || other.Zone != "outdoor" || !ok || otherDefinition.Category == "environment" || otherDefinition.Category == "creature" {
				continue
			}
			if placementsOverlap(candidate, item, other, otherDefinition) {
				clear = false
				break
			}
		}
		if clear {
			return candidate, true
		}
	}
	return original, false
}
