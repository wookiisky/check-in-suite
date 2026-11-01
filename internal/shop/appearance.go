package shop

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// readAppearanceSelection supplies free defaults until the first explicit save.
func readAppearanceSelection(ctx context.Context, tx *sql.Tx) (AppearanceState, error) {
	result := AppearanceState{Version: 1, CharacterKey: character.DefaultCharacterKey}
	err := tx.QueryRowContext(ctx, "SELECT version,character_key,hair_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id FROM appearance_state WHERE id=1").Scan(&result.Version, &result.CharacterKey, &result.HairPurchaseID, &result.UpperPurchaseID, &result.LowerPurchaseID, &result.ShoesPurchaseID)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	return result, err
}

// readAppearance keeps the selected outfit and complete wardrobe in one database snapshot.
func readAppearance(ctx context.Context, tx *sql.Tx) (AppearanceState, error) {
	result, err := readAppearanceSelection(ctx, tx)
	if err != nil {
		return result, err
	}
	result.Characters, result.Wearables = character.Definitions(), character.Wearables()
	result.Inventory = []AppearanceOwnedItem{}
	rows, err := tx.QueryContext(ctx, "SELECT id,wearable_key_snapshot FROM purchases WHERE type_snapshot=? AND status=? ORDER BY created_at,id", TypeWearable, StatusOwned)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item AppearanceOwnedItem
		if err = rows.Scan(&item.PurchaseID, &item.WearableKey); err != nil {
			return result, err
		}
		result.Inventory = append(result.Inventory, item)
	}
	return result, rows.Err()
}

// Appearance authorizes and reads the saved outfit without changing account or layout versions.
func (s *Service) Appearance(ctx context.Context, p account.Principal) (AppearanceState, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return AppearanceState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return AppearanceState{}, err
	}
	result, err := readAppearance(ctx, tx)
	if err != nil {
		return AppearanceState{}, err
	}
	return result, tx.Commit()
}

// validateAppearance checks ownership and compatibility independently from the live product offer.
func validateAppearance(ctx context.Context, tx *sql.Tx, input SaveAppearanceInput) error {
	body, ok := character.Get(input.CharacterKey)
	if !ok {
		return core.Invalid("character_key", "INVALID_VALUE")
	}
	for _, slot := range []struct {
		key        character.Slot // Required body attachment.
		field      string         // Request field used for an empty identifier error.
		purchaseID *string        // Nil selects the controlled free default.
	}{
		{character.SlotHair, "hair_purchase_id", input.HairPurchaseID},
		{character.SlotUpper, "upper_purchase_id", input.UpperPurchaseID},
		{character.SlotLower, "lower_purchase_id", input.LowerPurchaseID},
		{character.SlotShoes, "shoes_purchase_id", input.ShoesPurchaseID},
	} {
		if slot.purchaseID == nil {
			continue
		}
		if strings.TrimSpace(*slot.purchaseID) == "" {
			return core.Invalid(slot.field, "INVALID_VALUE")
		}
		purchase, err := readPurchase(ctx, tx, *slot.purchaseID)
		if err != nil {
			return err
		}
		wearable, found := character.GetWearable(purchase.WearableKey)
		if purchase.Status != StatusOwned || purchase.TypeSnapshot != TypeWearable || !found || wearable.Slot != slot.key || wearable.CharacterKey != body.Key || wearable.RigKey != body.RigKey {
			return core.Fail(422, "INVALID_EQUIPMENT")
		}
	}
	return nil
}

// SaveAppearance atomically replaces the body and all four slots after a version check.
func (s *Service) SaveAppearance(ctx context.Context, p account.Principal, input SaveAppearanceInput) (AppearanceState, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return AppearanceState{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return AppearanceState{}, err
	}
	if input.ExpectedVersion < 1 || input.ExpectedVersion > core.MaxInteger {
		return AppearanceState{}, core.Invalid("expected_version", "INVALID_VALUE")
	}
	current, err := readAppearanceSelection(ctx, tx)
	if err != nil {
		return AppearanceState{}, err
	}
	if current.Version != input.ExpectedVersion {
		return AppearanceState{}, core.VersionConflict(current.Version)
	}
	if err = validateAppearance(ctx, tx, input); err != nil {
		return AppearanceState{}, err
	}
	version, err := core.Add(current.Version, 1)
	if err != nil {
		return AppearanceState{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,hair_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id) VALUES(1,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,character_key=excluded.character_key,hair_purchase_id=excluded.hair_purchase_id,upper_purchase_id=excluded.upper_purchase_id,lower_purchase_id=excluded.lower_purchase_id,shoes_purchase_id=excluded.shoes_purchase_id`, version, input.CharacterKey, input.HairPurchaseID, input.UpperPurchaseID, input.LowerPurchaseID, input.ShoesPurchaseID)
	if err != nil {
		return AppearanceState{}, err
	}
	result, err := readAppearance(ctx, tx)
	if err != nil {
		return AppearanceState{}, err
	}
	if err = tx.Commit(); err != nil {
		return AppearanceState{}, err
	}
	slog.InfoContext(ctx, "外观保存成功", "request_id", core.RequestID(ctx), "version", version, "character_key", input.CharacterKey)
	return result, nil
}
