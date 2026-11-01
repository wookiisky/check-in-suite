package shop

import (
	"context"
	"database/sql"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// ReadEquipment reads the title in the caller's consistent snapshot.
func ReadEquipment(ctx context.Context, tx *sql.Tx) (Equipment, error) {
	result := Equipment{}
	var purchaseID *string
	if err := tx.QueryRowContext(ctx, "SELECT title_purchase_id FROM accounts WHERE id=1").Scan(&purchaseID); err != nil {
		return result, err
	}
	if purchaseID != nil {
		item, err := readPurchase(ctx, tx, *purchaseID)
		if err != nil {
			return result, err
		}
		result.Title = &item
	}
	return result, nil
}

// Equipment authorizes and reads the title independently from the character appearance.
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
		return Equipment{}, err
	}
	return result, tx.Commit()
}

// SetTitle equips an owned title or clears it without changing the appearance or profile version.
func (s *Service) SetTitle(ctx context.Context, p account.Principal, purchaseID *string) (Equipment, error) {
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
		if strings.TrimSpace(*purchaseID) == "" {
			return Equipment{}, core.Invalid("purchase_id", "INVALID_VALUE")
		}
		item, err := readPurchase(ctx, tx, *purchaseID)
		if err != nil {
			return Equipment{}, err
		}
		if item.TypeSnapshot != TypeTitle || item.Status != StatusOwned {
			return Equipment{}, core.Fail(422, "INVALID_EQUIPMENT")
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET title_purchase_id=?,updated_at=? WHERE id=1", purchaseID, now.UnixMilli()); err != nil {
		return Equipment{}, err
	}
	result, err := ReadEquipment(ctx, tx)
	if err != nil {
		return Equipment{}, err
	}
	return result, tx.Commit()
}
