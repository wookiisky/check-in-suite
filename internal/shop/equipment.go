package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// ReadEquipment uses the caller's snapshot so camp equipment and wallet describe the same writes.
func ReadEquipment(ctx context.Context, tx *sql.Tx) (Equipment, error) {
	result := Equipment{Accessories: []Purchase{}, Effects: []Purchase{}, AccessoryLayouts: map[string]AccessoryLayout{}}
	var titleID, avatarID, backgroundID sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT title_purchase_id,avatar_purchase_id,background_purchase_id FROM accounts WHERE id=1").Scan(&titleID, &avatarID, &backgroundID); err != nil {
		return result, err
	}
	for _, slot := range []struct {
		id     sql.NullString // Persisted single-slot purchase identity.
		target **Purchase     // Output slot receiving the immutable purchase snapshot.
	}{{titleID, &result.Title}, {avatarID, &result.Avatar}, {backgroundID, &result.Background}} {
		if slot.id.Valid {
			item, err := readPurchase(ctx, tx, slot.id.String)
			if err != nil {
				return result, err
			}
			*slot.target = &item
		}
	}
	var err error
	result.Accessories, err = readEquippedItems(ctx, tx, "equipped_accessories")
	if err != nil {
		return result, err
	}
	result.Effects, err = readEquippedItems(ctx, tx, "equipped_effects")
	if err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT l.purchase_id,l.x,l.y,l.size,l.layer FROM accessory_layouts l JOIN equipped_accessories e ON e.purchase_id=l.purchase_id")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var layout AccessoryLayout
		if err := rows.Scan(&id, &layout.X, &layout.Y, &layout.Size, &layout.Layer); err != nil {
			return result, err
		}
		result.AccessoryLayouts[id] = layout
	}
	return result, rows.Err()
}

// readEquippedItems reads a trusted module-owned equipment table with stable ordering.
func readEquippedItems(ctx context.Context, tx *sql.Tx, table string) ([]Purchase, error) {
	result := []Purchase{}
	rows, err := tx.QueryContext(ctx, "SELECT "+purchaseColumns+" FROM "+table+" e JOIN purchases p ON p.id=e.purchase_id ORDER BY e.equipped_at,e.purchase_id")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanPurchase(rows)
		if err != nil {
			return result, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// Equipment reads the currently saved outfit with server-side session authorization.
func (s *Service) Equipment(ctx context.Context, p account.Principal) (Equipment, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Equipment{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return Equipment{}, err
	}
	result, err := ReadEquipment(ctx, tx)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// SetSlot changes one permanent slot without rewriting other equipment or profile versions.
func (s *Service) SetSlot(ctx context.Context, p account.Principal, slot string, purchaseID *string) (Equipment, error) {
	var column string
	switch slot {
	case TypeTitle:
		column = "title_purchase_id"
	case TypeAvatar:
		column = "avatar_purchase_id"
	case TypeBackground:
		column = "background_purchase_id"
	default:
		return Equipment{}, core.Invalid("slot", "INVALID_VALUE")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Equipment{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return Equipment{}, err
	}
	if purchaseID != nil {
		item, err := readPurchase(ctx, tx, *purchaseID)
		if err != nil {
			return Equipment{}, err
		}
		if item.TypeSnapshot != slot || item.Status != StatusOwned {
			return Equipment{}, core.Fail(422, "INVALID_EQUIPMENT")
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET "+column+"=?,updated_at=? WHERE id=1", purchaseID, now.UnixMilli()); err != nil {
		return Equipment{}, err
	}
	result, err := ReadEquipment(ctx, tx)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// SetAccessory changes one accessory while enforcing the shared ten-item bound.
func (s *Service) SetAccessory(ctx context.Context, p account.Principal, purchaseID string, equipped bool) (AccessoryResult, error) {
	return s.setDecoration(ctx, p, purchaseID, equipped, TypeAccessory)
}

// SetEffect independently toggles a fixed overlay without consuming an accessory slot.
func (s *Service) SetEffect(ctx context.Context, p account.Principal, purchaseID string, equipped bool) (AccessoryResult, error) {
	return s.setDecoration(ctx, p, purchaseID, equipped, TypeEffect)
}

// setDecoration validates ownership and changes only the selected permanent decoration.
// Geometry survives unequipping; equipping a remembered accessory brings it to the front.
func (s *Service) setDecoration(ctx context.Context, p account.Principal, purchaseID string, equipped bool, kind string) (AccessoryResult, error) {
	result := AccessoryResult{PurchaseID: purchaseID, Equipped: equipped}
	table := "equipped_accessories"
	if kind == TypeEffect {
		table = "equipped_effects"
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return result, err
	}
	item, err := readPurchase(ctx, tx, purchaseID)
	if err != nil {
		return result, err
	}
	if item.TypeSnapshot != kind || item.Status != StatusOwned {
		return result, core.Fail(422, "INVALID_EQUIPMENT")
	}
	if !equipped {
		if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE purchase_id=?", purchaseID); err != nil {
			return result, err
		}
		return result, tx.Commit()
	}
	var already bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM "+table+" WHERE purchase_id=?)", purchaseID).Scan(&already); err != nil {
		return result, err
	}
	if already {
		return result, tx.Commit()
	}
	if kind == TypeAccessory {
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM equipped_accessories").Scan(&count); err != nil {
			return result, err
		}
		if count >= AccessoryLimit {
			return result, core.Fail(409, "ACCESSORY_LIMIT")
		}
		var layer int
		if err = tx.QueryRowContext(ctx, "SELECT MAX(0,COALESCE(MAX(l.layer),0))+1 FROM accessory_layouts l JOIN equipped_accessories e ON e.purchase_id=l.purchase_id").Scan(&layer); err != nil {
			return result, err
		}
		y := .12
		if count >= 5 {
			y = .88
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO accessory_layouts(purchase_id,x,y,size,layer) VALUES(?,?,?,.18,?) ON CONFLICT(purchase_id) DO UPDATE SET layer=excluded.layer", purchaseID, (float64(count%5)+.5)/5, y, layer); err != nil {
			return result, err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO "+table+"(purchase_id,equipped_at) VALUES(?,?)", purchaseID, now.UnixMilli()); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
