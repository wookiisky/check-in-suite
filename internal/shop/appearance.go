package shop

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"slices"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// readAppearanceSelection supplies free defaults until the first explicit save.
func readAppearanceSelection(ctx context.Context, tx *sql.Tx, accountID int64) (AppearanceState, error) {
	result := AppearanceState{Version: 1, CharacterKey: character.DefaultCharacterKey, DefaultCharacterKey: character.DefaultCharacterKey}
	err := tx.QueryRowContext(ctx, `SELECT version,character_key,face_purchase_id,head_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id,back_purchase_id,
        face_free_wearable_key,head_free_wearable_key,upper_free_wearable_key,lower_free_wearable_key,shoes_free_wearable_key,back_free_wearable_key,upper_color_key,back_color_key
        FROM appearance_state WHERE id=?`, accountID).Scan(
		&result.Version, &result.CharacterKey, &result.FacePurchaseID, &result.HeadPurchaseID, &result.UpperPurchaseID, &result.LowerPurchaseID, &result.ShoesPurchaseID, &result.BackPurchaseID,
		&result.FaceFreeWearableKey, &result.HeadFreeWearableKey, &result.UpperFreeWearableKey, &result.LowerFreeWearableKey, &result.ShoesFreeWearableKey, &result.BackFreeWearableKey, &result.UpperColorKey, &result.BackColorKey)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	return result, err
}

// readAppearance keeps the selected outfit and complete wardrobe in one database snapshot.
func readAppearance(ctx context.Context, tx *sql.Tx, accountID int64) (AppearanceState, error) {
	result, err := readAppearanceSelection(ctx, tx, accountID)
	if err != nil {
		return result, err
	}
	result.Characters, result.Wearables = character.Definitions(), character.Wearables()
	result.PreviewAnimations = character.PreviewAnimations()
	result.WearableColors = character.WearableColors()
	result.Inventory = []AppearanceOwnedItem{}
	result.CharacterInventory = []AppearanceOwnedCharacter{}
	rows, err := tx.QueryContext(ctx, "SELECT id,wearable_key_snapshot,character_key_snapshot,type_snapshot FROM purchases WHERE account_id=? AND type_snapshot IN (?,?) AND status=? ORDER BY created_at,id", accountID, TypeWearable, TypeCharacter, StatusOwned)
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
		} else {
			result.Inventory = append(result.Inventory, item)
		}
	}
	return result, rows.Err()
}

// Appearance authorizes and reads the saved outfit without changing account or layout versions.
func (s *Service) Appearance(ctx context.Context, p account.Principal) (AppearanceState, error) {
	accountID := p.AccountID
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return AppearanceState{}, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return AppearanceState{}, err
	}
	result, err := readAppearance(ctx, tx, accountID)
	if err != nil {
		return AppearanceState{}, err
	}
	return result, tx.Commit()
}

// validateAppearance checks ownership and compatibility independently from the live product offer.
func validateAppearance(ctx context.Context, tx *sql.Tx, accountID int64, input SaveAppearanceInput) error {
	body, ok := character.Get(input.CharacterKey)
	if !ok {
		return core.Invalid("character_key", "INVALID_VALUE")
	}
	// 默认部件权益属于已取得的基础身体，不把角色订单伪装成衣物订单。
	ownedBodies := map[string]bool{character.DefaultCharacterKey: true}
	rows, err := tx.QueryContext(ctx, "SELECT character_key_snapshot FROM purchases WHERE account_id=? AND type_snapshot=? AND status=?", accountID, TypeCharacter, StatusOwned)
	if err != nil {
		return err
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		ownedBodies[key] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !ownedBodies[body.Key] {
		return core.Fail(422, "INVALID_EQUIPMENT")
	}

	palette := character.WearableColors()
	for _, slot := range []struct {
		key        character.Slot // Required body attachment.
		field      string         // Request field used for an empty identifier error.
		purchaseID *string        // Nil selects the character default unless a free garment is explicit.
		freeField  string         // Optional initial free garment request field.
		freeKey    *string        // 可共用的已取得身体默认部件。
		colorKey   *string        // 可选预设色，空值使用素材底色。
	}{
		{character.SlotFace, "face_purchase_id", input.FacePurchaseID, "face_free_wearable_key", input.FaceFreeWearableKey, nil},
		{character.SlotHead, "head_purchase_id", input.HeadPurchaseID, "head_free_wearable_key", input.HeadFreeWearableKey, nil},
		{character.SlotUpper, "upper_purchase_id", input.UpperPurchaseID, "upper_free_wearable_key", input.UpperFreeWearableKey, input.UpperColorKey},
		{character.SlotLower, "lower_purchase_id", input.LowerPurchaseID, "lower_free_wearable_key", input.LowerFreeWearableKey, nil},
		{character.SlotShoes, "shoes_purchase_id", input.ShoesPurchaseID, "shoes_free_wearable_key", input.ShoesFreeWearableKey, nil},
		{character.SlotBack, "back_purchase_id", input.BackPurchaseID, "back_free_wearable_key", input.BackFreeWearableKey, input.BackColorKey},
	} {
		wearableKey := body.Defaults.ForSlot(slot.key)
		switch {
		case slot.freeKey != nil:
			if strings.TrimSpace(*slot.freeKey) == "" {
				return core.Invalid(slot.freeField, "INVALID_VALUE")
			}
			entitled := false
			for _, source := range character.Definitions() {
				if ownedBodies[source.Key] && source.Defaults.ForSlot(slot.key) == *slot.freeKey {
					entitled = true
					break
				}
			}
			if slot.purchaseID != nil || !entitled {
				return core.Fail(422, "INVALID_EQUIPMENT")
			}
			wearableKey = *slot.freeKey
		case slot.purchaseID != nil:
			if strings.TrimSpace(*slot.purchaseID) == "" {
				return core.Invalid(slot.field, "INVALID_VALUE")
			}
			purchase, err := readPurchase(ctx, tx, accountID, *slot.purchaseID)
			if err != nil {
				return err
			}
			if purchase.Status != StatusOwned || purchase.TypeSnapshot != TypeWearable {
				return core.Fail(422, "INVALID_EQUIPMENT")
			}
			wearableKey = purchase.WearableKey
		case slot.colorKey == nil:
			continue
		}
		wearable, found := character.GetWearable(wearableKey)
		if !found || wearable.Slot != slot.key || !compatibleBody(wearable, body) || wearable.RigKey != body.RigKey {
			return core.Fail(422, "INVALID_EQUIPMENT")
		}
		if slot.colorKey != nil {
			if !slices.ContainsFunc(palette, func(color character.WearableColor) bool { return color.Key == *slot.colorKey }) {
				return core.Invalid(string(slot.key)+"_color_key", "INVALID_VALUE")
			}
			if wearable.DyeMaterial == "" {
				return core.Fail(422, "INVALID_EQUIPMENT")
			}
		}
	}
	return nil
}

// SaveAppearance atomically replaces the body and all six slots after a version check.
func (s *Service) SaveAppearance(ctx context.Context, p account.Principal, input SaveAppearanceInput) (AppearanceState, error) {
	accountID := p.AccountID
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
	current, err := readAppearanceSelection(ctx, tx, accountID)
	if err != nil {
		return AppearanceState{}, err
	}
	if current.Version != input.ExpectedVersion {
		return AppearanceState{}, core.VersionConflict(current.Version)
	}
	if err = validateAppearance(ctx, tx, accountID, input); err != nil {
		return AppearanceState{}, err
	}
	version, err := core.Add(current.Version, 1)
	if err != nil {
		return AppearanceState{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,face_purchase_id,head_purchase_id,upper_purchase_id,lower_purchase_id,shoes_purchase_id,back_purchase_id,
        face_free_wearable_key,head_free_wearable_key,upper_free_wearable_key,lower_free_wearable_key,shoes_free_wearable_key,back_free_wearable_key,upper_color_key,back_color_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,character_key=excluded.character_key,
        face_purchase_id=excluded.face_purchase_id,head_purchase_id=excluded.head_purchase_id,upper_purchase_id=excluded.upper_purchase_id,
        lower_purchase_id=excluded.lower_purchase_id,shoes_purchase_id=excluded.shoes_purchase_id,back_purchase_id=excluded.back_purchase_id,
        face_free_wearable_key=excluded.face_free_wearable_key,head_free_wearable_key=excluded.head_free_wearable_key,upper_free_wearable_key=excluded.upper_free_wearable_key,
        lower_free_wearable_key=excluded.lower_free_wearable_key,shoes_free_wearable_key=excluded.shoes_free_wearable_key,back_free_wearable_key=excluded.back_free_wearable_key,
        upper_color_key=excluded.upper_color_key,back_color_key=excluded.back_color_key`, accountID, version, input.CharacterKey,
		input.FacePurchaseID, input.HeadPurchaseID, input.UpperPurchaseID, input.LowerPurchaseID, input.ShoesPurchaseID, input.BackPurchaseID,
		input.FaceFreeWearableKey, input.HeadFreeWearableKey, input.UpperFreeWearableKey, input.LowerFreeWearableKey, input.ShoesFreeWearableKey, input.BackFreeWearableKey,
		input.UpperColorKey, input.BackColorKey)
	if err != nil {
		return AppearanceState{}, err
	}
	result, err := readAppearance(ctx, tx, accountID)
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
