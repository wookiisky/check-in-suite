package island

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// readState resolves ownership using all purchases, never the paginated shop view.
func readState(ctx context.Context, tx *sql.Tx) (State, error) {
	state := State{Version: 1, Placements: defaultPlacements(), Inventory: baseInventory(), Catalog: Catalog()}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT version,placements FROM island_state WHERE id=1").Scan(&state.Version, &raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return state, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &state.Placements); err != nil {
			return state, err
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,asset_key_snapshot,item_key_snapshot FROM purchases WHERE status='owned' ORDER BY created_at,id")
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, key, itemKey string
		if err = rows.Scan(&id, &key, &itemKey); err != nil {
			return state, err
		}
		item, ok := Find(itemKey)
		if itemKey == "" {
			item, ok = ForAsset(key)
		}
		if ok {
			state.Inventory = append(state.Inventory, OwnedItem{id, item.Key})
		}
	}
	return state, rows.Err()
}

// Read returns authorized layout and inventory from one database snapshot.
func (s *Service) Read(ctx context.Context, p account.Principal) (State, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return State{}, err
	}
	result, err := readState(ctx, tx)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// Save validates ownership and layout before atomically advancing the version.
func (s *Service) Save(ctx context.Context, p account.Principal, input SaveInput) (State, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return State{}, err
	}
	state, err := readState(ctx, tx)
	if err != nil {
		return state, err
	}
	if input.ExpectedVersion != state.Version {
		return State{}, core.Fail(409, "VERSION_CONFLICT")
	}
	if err = validatePlacements(input.Placements, state); err != nil {
		return State{}, err
	}
	data, err := json.Marshal(input.Placements)
	if err != nil {
		return State{}, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO island_state(id,version,placements) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,placements=excluded.placements", state.Version+1, string(data))
	if err != nil {
		return State{}, err
	}
	state.Version++
	state.Placements = input.Placements
	return state, tx.Commit()
}

// validatePlacements enforces ownership, scene bounds and singular house/environment slots.
func validatePlacements(placements []Placement, state State) error {
	invalid := func() error { return core.Invalid("placements", "INVALID_VALUE") }
	if placements == nil || len(placements) > len(state.Inventory) {
		return invalid()
	}
	owned := make(map[string]string, len(state.Inventory))
	for _, item := range state.Inventory {
		owned[item.ID] = item.ItemKey
	}
	seen := make(map[string]bool, len(placements))
	houses, environments := 0, 0
	for _, p := range placements {
		definition, ok := Find(p.ItemKey)
		if !ok || owned[p.ID] != p.ItemKey || seen[p.ID] {
			return invalid()
		}
		seen[p.ID] = true
		if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) {
			return invalid()
		}
		if p.Rotation != 0 && p.Rotation != 90 && p.Rotation != 180 && p.Rotation != 270 {
			return invalid()
		}
		limit := 8.0
		if p.Zone == "indoor" {
			limit = 2
		} else if p.Zone != "outdoor" {
			return invalid()
		}
		width, depth := definition.Width, definition.Depth
		if p.Rotation == 90 || p.Rotation == 270 {
			width, depth = depth, width
		}
		if math.Abs(p.X)+width/2 > limit || math.Abs(p.Y)+depth/2 > limit {
			return invalid()
		}
		if definition.Category == "house" {
			houses++
			if p.Zone != "outdoor" || p.Rotation != 0 {
				return invalid()
			}
		}
		if definition.Category == "environment" {
			environments++
			if p.Zone != "outdoor" || p.X != 0 || p.Y != 0 || p.Rotation != 0 {
				return invalid()
			}
		}
		if definition.Model == "run" && p.Zone != "outdoor" {
			return invalid()
		}
		if !definition.Movable && definition.Category != "environment" {
			for _, saved := range state.Placements {
				if saved.ID == p.ID && (saved.X != p.X || saved.Y != p.Y || saved.Rotation != p.Rotation || saved.Zone != p.Zone) {
					return invalid()
				}
			}
		}
	}
	if houses != 1 || environments != 1 {
		return invalid()
	}
	// Furniture may share visual ground with books, but outdoor solid objects cannot seal the home entrance.
	for _, house := range placements {
		d, _ := Find(house.ItemKey)
		if d.Category != "house" {
			continue
		}
		doorX, doorY := house.X, house.Y
		doorY += d.Depth/2 + 0.6
		if math.Abs(doorX) > 7.5 || math.Abs(doorY) > 7.5 {
			return invalid()
		}
		for _, p := range placements {
			item, _ := Find(p.ItemKey)
			if p.ID == house.ID || p.Zone != "outdoor" || item.Category == "environment" || item.Category == "creature" {
				continue
			}
			width, depth := item.Width, item.Depth
			if p.Rotation == 90 || p.Rotation == 270 {
				width, depth = depth, width
			}
			if math.Abs(p.X-doorX) < width/2+0.3 && math.Abs(p.Y-doorY) < depth/2+0.3 {
				return invalid()
			}
		}
	}
	return nil
}
