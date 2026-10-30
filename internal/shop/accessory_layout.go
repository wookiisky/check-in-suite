package shop

import (
	"context"
	"errors"
	"math"
	"sort"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

const avatarLayerID = "avatar" // Stable ordering anchor independent of the chosen character purchase.

// validateAccessoryLayout keeps the complete rotated image box inside the normalized canvas.
func validateAccessoryLayout(purchaseID string, input AccessoryLayoutInput) error {
	for field, value := range map[string]float64{"x": input.X, "y": input.Y, "size": input.Size, "rotation": input.Rotation} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return core.Invalid(field, "INVALID_VALUE")
		}
	}
	if input.Size < .05 || input.Size > 1 {
		return core.Invalid("size", "INVALID_VALUE")
	}
	if input.Rotation < 0 || input.Rotation >= 360 {
		return core.Invalid("rotation", "INVALID_VALUE")
	}
	radians := input.Rotation * math.Pi / 180
	half := input.Size * (math.Abs(math.Cos(radians)) + math.Abs(math.Sin(radians))) / 2
	// Cardinal angles and exact edge contact can differ by a few floating-point bits.
	const tolerance = 1e-9
	if input.X < half-tolerance || input.X > 1-half+tolerance {
		return core.Invalid("x", "INVALID_VALUE")
	}
	if input.Y < half-tolerance || input.Y > 1-half+tolerance {
		return core.Invalid("y", "INVALID_VALUE")
	}
	if input.BeforeID != nil && *input.BeforeID == purchaseID {
		return core.Invalid("before_id", "INVALID_VALUE")
	}
	return nil
}

// SetAccessoryLayout atomically saves one item's geometry and absolute ordering intent.
// Other geometries and equipment are preserved; repeated saves do not keep moving an item.
func (s *Service) SetAccessoryLayout(ctx context.Context, p account.Principal, purchaseID string, input AccessoryLayoutInput) (Equipment, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Equipment{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return Equipment{}, err
	}
	item, err := readPurchase(ctx, tx, purchaseID)
	if err != nil {
		var failure *core.Error
		if errors.As(err, &failure) && failure.Code == "NOT_FOUND" {
			return Equipment{}, core.Fail(409, "EQUIPMENT_CHANGED")
		}
		return Equipment{}, err
	}
	if item.WearableSlot != "" {
		return Equipment{}, core.Fail(422, "INVALID_EQUIPMENT")
	}
	if err = validateAccessoryLayout(purchaseID, input); err != nil {
		return Equipment{}, err
	}
	current, err := ReadEquipment(ctx, tx)
	if err != nil {
		return Equipment{}, err
	}
	if _, exists := current.AccessoryLayouts[purchaseID]; !exists {
		return Equipment{}, core.Fail(409, "EQUIPMENT_CHANGED")
	}
	if input.BeforeID != nil && *input.BeforeID != avatarLayerID {
		if _, exists := current.AccessoryLayouts[*input.BeforeID]; !exists {
			return Equipment{}, core.Fail(409, "EQUIPMENT_CHANGED")
		}
	}
	order := []string{avatarLayerID}
	for _, item := range current.Accessories {
		if item.ID != purchaseID {
			order = append(order, item.ID)
		}
	}
	// The character's zero value sorts between negative and positive accessory layers.
	sort.Slice(order, func(i, j int) bool {
		a, b := current.AccessoryLayouts[order[i]].Layer, current.AccessoryLayouts[order[j]].Layer
		if a == b {
			return order[i] < order[j]
		}
		return a < b
	})
	insertion := len(order)
	if input.BeforeID != nil {
		for i, id := range order {
			if id == *input.BeforeID {
				insertion = i
				break
			}
		}
	}
	order = append(order, "")
	copy(order[insertion+1:], order[insertion:])
	order[insertion] = purchaseID
	avatarIndex := 0
	for i, id := range order {
		if id == avatarLayerID {
			avatarIndex = i
			break
		}
	}
	for i, id := range order {
		if id == avatarLayerID {
			continue
		}
		if _, err = tx.ExecContext(ctx, "UPDATE accessory_layouts SET layer=? WHERE purchase_id=?", i-avatarIndex, id); err != nil {
			return Equipment{}, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accessory_layouts SET x=?,y=?,size=?,rotation=? WHERE purchase_id=?", input.X, input.Y, input.Size, input.Rotation, purchaseID); err != nil {
		return Equipment{}, err
	}
	result, err := ReadEquipment(ctx, tx)
	if err != nil {
		return Equipment{}, err
	}
	return result, tx.Commit()
}
