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
	result := AppearanceState{Version: 1, CharacterKey: character.DefaultCharacterKey, DefaultCharacterKey: character.DefaultCharacterKey}
	err := tx.QueryRowContext(ctx, "SELECT version,character_key,hair_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id,hair_free_wearable_key,upper_free_wearable_key,lower_free_wearable_key,shoes_free_wearable_key FROM appearance_state WHERE id=1").Scan(&result.Version, &result.CharacterKey, &result.HairPurchaseID, &result.UpperPurchaseID, &result.LowerPurchaseID, &result.ShoesPurchaseID, &result.HairFreeWearableKey, &result.UpperFreeWearableKey, &result.LowerFreeWearableKey, &result.ShoesFreeWearableKey)
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
	result.PreviewAnimations = character.PreviewAnimations()
	result.Inventory = []AppearanceOwnedItem{}
	result.CharacterInventory = []AppearanceOwnedCharacter{}
	rows, err := tx.QueryContext(ctx, "SELECT id,wearable_key_snapshot,character_key_snapshot,type_snapshot FROM purchases WHERE type_snapshot IN (?,?) AND status=? ORDER BY created_at,id", TypeWearable, TypeCharacter, StatusOwned)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item AppearanceOwnedItem
		var bodyKey, kind string
		if err = rows.Scan(&item.PurchaseID, &item.WearableKey, &bodyKey, &kind); err != nil {
			return result, err
		}
		if kind == TypeCharacter {
			result.CharacterInventory = append(result.CharacterInventory, AppearanceOwnedCharacter{PurchaseID: item.PurchaseID, CharacterKey: bodyKey})
			if definition, ok := character.Get(bodyKey); ok {
				for _, wearableKey := range []string{definition.Defaults.Hair, definition.Defaults.Upper, definition.Defaults.Lower, definition.Defaults.Shoes} {
					result.Inventory = append(result.Inventory, AppearanceOwnedItem{PurchaseID: item.PurchaseID, WearableKey: wearableKey})
				}
			}
		} else {
			result.Inventory = append(result.Inventory, item)
		}
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
	if body.Key != character.DefaultCharacterKey {
		var owned bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM purchases WHERE type_snapshot=? AND character_key_snapshot=? AND status=?)", TypeCharacter, body.Key, StatusOwned).Scan(&owned); err != nil {
			return err
		}
		if !owned {
			return core.Fail(422, "INVALID_EQUIPMENT")
		}
	}
	for _, slot := range []struct {
		key        character.Slot // Required body attachment.
		field      string         // Request field used for an empty identifier error.
		purchaseID *string        // Nil selects the character default unless a free garment is explicit.
		freeField  string         // Optional initial free garment request field.
		freeKey    *string        // Only a default garment of the initial free character can be shared.
	}{
		{character.SlotHair, "hair_purchase_id", input.HairPurchaseID, "hair_free_wearable_key", input.HairFreeWearableKey},
		{character.SlotUpper, "upper_purchase_id", input.UpperPurchaseID, "upper_free_wearable_key", input.UpperFreeWearableKey},
		{character.SlotLower, "lower_purchase_id", input.LowerPurchaseID, "lower_free_wearable_key", input.LowerFreeWearableKey},
		{character.SlotShoes, "shoes_purchase_id", input.ShoesPurchaseID, "shoes_free_wearable_key", input.ShoesFreeWearableKey},
	} {
		if slot.freeKey != nil {
			if strings.TrimSpace(*slot.freeKey) == "" {
				return core.Invalid(slot.freeField, "INVALID_VALUE")
			}
			free, ok := character.Get(character.DefaultCharacterKey)
			wearable, found := character.GetWearable(*slot.freeKey)
			if slot.purchaseID != nil || !ok || !found || defaultWearableKey(free.Defaults, slot.key) != *slot.freeKey || wearable.Slot != slot.key || !compatibleBody(wearable, body) || wearable.RigKey != body.RigKey {
				return core.Fail(422, "INVALID_EQUIPMENT")
			}
			continue
		}
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
		wearableKey := purchase.WearableKey
		if purchase.TypeSnapshot == TypeCharacter {
			if definition, ok := character.Get(purchase.CharacterKey); ok {
				wearableKey = defaultWearableKey(definition.Defaults, slot.key)
			}
		}
		wearable, found := character.GetWearable(wearableKey)
		if purchase.Status != StatusOwned || (purchase.TypeSnapshot != TypeWearable && purchase.TypeSnapshot != TypeCharacter) || !found || wearable.Slot != slot.key || !compatibleBody(wearable, body) || wearable.RigKey != body.RigKey {
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
	_, err = tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,hair_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id,hair_free_wearable_key,upper_free_wearable_key,lower_free_wearable_key,shoes_free_wearable_key) VALUES(1,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,character_key=excluded.character_key,hair_purchase_id=excluded.hair_purchase_id,upper_purchase_id=excluded.upper_purchase_id,lower_purchase_id=excluded.lower_purchase_id,shoes_purchase_id=excluded.shoes_purchase_id,hair_free_wearable_key=excluded.hair_free_wearable_key,upper_free_wearable_key=excluded.upper_free_wearable_key,lower_free_wearable_key=excluded.lower_free_wearable_key,shoes_free_wearable_key=excluded.shoes_free_wearable_key`, version, input.CharacterKey, input.HairPurchaseID, input.UpperPurchaseID, input.LowerPurchaseID, input.ShoesPurchaseID, input.HairFreeWearableKey, input.UpperFreeWearableKey, input.LowerFreeWearableKey, input.ShoesFreeWearableKey)
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

// compatibleBody permits garments shared by normalized bodies while retaining legacy definitions.
func compatibleBody(wearable character.Wearable, body character.Definition) bool {
	garmentBody := wearable.BodyKey
	if garmentBody == "" {
		if original, ok := character.Get(wearable.CharacterKey); ok {
			garmentBody = original.BodyKey
		}
	}
	if garmentBody != "" && body.BodyKey != "" {
		return garmentBody == body.BodyKey
	}
	return wearable.CharacterKey == body.Key
}

// defaultWearableKey resolves a declared slot without guessing a garment's identity from its name.
func defaultWearableKey(selection character.Selection, slot character.Slot) string {
	switch slot {
	case character.SlotHair:
		return selection.Hair
	case character.SlotUpper:
		return selection.Upper
	case character.SlotLower:
		return selection.Lower
	case character.SlotShoes:
		return selection.Shoes
	}
	return ""
}
