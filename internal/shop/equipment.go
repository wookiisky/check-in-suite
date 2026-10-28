package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// ReadEquipment uses the caller's snapshot so camp equipment and wallet cannot describe different writes.
func ReadEquipment(ctx context.Context, tx *sql.Tx) (Equipment, error) {
	result := Equipment{Accessories: []Purchase{}}
	var titleID, avatarID sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT title_purchase_id,avatar_purchase_id FROM accounts WHERE id=1").Scan(&titleID, &avatarID); err != nil {
		return result, err
	}
	if titleID.Valid {
		item, err := readPurchase(ctx, tx, titleID.String)
		if err != nil {
			return result, err
		}
		result.Title = &item
	}
	if avatarID.Valid {
		item, err := readPurchase(ctx, tx, avatarID.String)
		if err != nil {
			return result, err
		}
		result.Avatar = &item
	}
	rows, err := tx.QueryContext(ctx, "SELECT "+purchaseColumns+" FROM equipped_accessories e JOIN purchases p ON p.id=e.purchase_id ORDER BY e.equipped_at,e.purchase_id")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanPurchase(rows)
		if err != nil {
			return result, err
		}
		result.Accessories = append(result.Accessories, item)
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

// SetAccessory checks and changes only the selected item while serializing the global ten-item bound.
func (s *Service) SetAccessory(ctx context.Context, p account.Principal, purchaseID string, equipped bool) (AccessoryResult, error) {
	result := AccessoryResult{PurchaseID: purchaseID, Equipped: equipped}
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
	if item.TypeSnapshot != TypeAccessory || item.Status != StatusOwned {
		return result, core.Fail(422, "INVALID_EQUIPMENT")
	}
	if !equipped {
		if _, err = tx.ExecContext(ctx, "DELETE FROM equipped_accessories WHERE purchase_id=?", purchaseID); err != nil {
			return result, err
		}
		return result, tx.Commit()
	}
	var already bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM equipped_accessories WHERE purchase_id=?)", purchaseID).Scan(&already); err != nil {
		return result, err
	}
	if already {
		return result, tx.Commit()
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM equipped_accessories").Scan(&count); err != nil {
		return result, err
	}
	if count >= AccessoryLimit {
		return result, core.Fail(409, "ACCESSORY_LIMIT")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO equipped_accessories(purchase_id,equipped_at) VALUES(?,?)", purchaseID, now.UnixMilli()); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
