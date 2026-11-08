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
	err := tx.QueryRowContext(ctx, `SELECT version,character_key,face_wearable_key,head_wearable_key,upper_wearable_key,lower_wearable_key,shoes_wearable_key,back_wearable_key,
        head_color_key,upper_color_key,lower_color_key,shoes_color_key,back_color_key
        FROM appearance_state WHERE id=?`, accountID).Scan(
		&result.Version, &result.CharacterKey, &result.FaceWearableKey, &result.HeadWearableKey, &result.UpperWearableKey, &result.LowerWearableKey, &result.ShoesWearableKey, &result.BackWearableKey,
		&result.HeadColorKey, &result.UpperColorKey, &result.LowerColorKey, &result.ShoesColorKey, &result.BackColorKey)
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
	rows, err := tx.QueryContext(ctx, "SELECT wearable_key_snapshot,character_key_snapshot,type_snapshot FROM purchases WHERE account_id=? AND type_snapshot IN (?,?) AND status=? ORDER BY created_at,id", accountID, TypeWearable, TypeCharacter, StatusOwned)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item AppearanceOwnedItem
		var bodyKey, kind string
		if err = rows.Scan(&item.WearableKey, &bodyKey, &kind); err != nil {
			return result, err
		}
		if kind == TypeCharacter {
			result.CharacterInventory = append(result.CharacterInventory, AppearanceOwnedCharacter{CharacterKey: bodyKey})
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
func validateAppearance(current AppearanceState, input SaveAppearanceInput) error {
	index := slices.IndexFunc(current.Characters, func(body character.Definition) bool { return body.Key == input.CharacterKey })
	if index < 0 {
		return core.Invalid("character_key", "INVALID_VALUE")
	}
	body := current.Characters[index]
	// 默认件由已取得的身体授予，付费件由订单授予。
	ownedBodies := map[string]bool{current.DefaultCharacterKey: true}
	for _, item := range current.CharacterInventory {
		ownedBodies[item.CharacterKey] = true
	}
	if !ownedBodies[body.Key] {
		return core.Fail(422, "INVALID_EQUIPMENT")
	}
	ownedWearables := make(map[string]bool, len(current.Inventory))
	for _, item := range current.Inventory {
		ownedWearables[item.WearableKey] = true
	}
	for _, source := range current.Characters {
		if ownedBodies[source.Key] {
			for _, slot := range character.Slots() {
				ownedWearables[source.Defaults.ForSlot(slot)] = true
			}
		}
	}

	for _, selection := range []struct {
		slot     character.Slot // 穿戴部位。
		key      *string        // 空值使用当前身体默认件。
		colorKey *string        // 空值使用素材底色。
	}{
		{character.SlotFace, input.FaceWearableKey, nil},
		{character.SlotHead, input.HeadWearableKey, input.HeadColorKey},
		{character.SlotUpper, input.UpperWearableKey, input.UpperColorKey},
		{character.SlotLower, input.LowerWearableKey, input.LowerColorKey},
		{character.SlotShoes, input.ShoesWearableKey, input.ShoesColorKey},
		{character.SlotBack, input.BackWearableKey, input.BackColorKey},
	} {
		wearableKey := body.Defaults.ForSlot(selection.slot)
		if selection.key != nil {
			wearableKey = *selection.key
			if strings.TrimSpace(wearableKey) == "" {
				return core.Invalid(string(selection.slot)+"_wearable_key", "INVALID_VALUE")
			}
			if !ownedWearables[wearableKey] {
				return core.Fail(422, "INVALID_EQUIPMENT")
			}
		}
		index := slices.IndexFunc(current.Wearables, func(item character.Wearable) bool { return item.Key == wearableKey })
		if index < 0 {
			return core.Fail(422, "INVALID_EQUIPMENT")
		}
		wearable := current.Wearables[index]
		if wearable.Slot != selection.slot || !compatibleBody(wearable, body) || wearable.RigKey != body.RigKey {
			return core.Fail(422, "INVALID_EQUIPMENT")
		}
		if selection.colorKey != nil {
			if !slices.ContainsFunc(current.WearableColors, func(color character.WearableColor) bool { return color.Key == *selection.colorKey }) {
				return core.Invalid(string(selection.slot)+"_color_key", "INVALID_VALUE")
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
	current, err := readAppearance(ctx, tx, accountID)
	if err != nil {
		return AppearanceState{}, err
	}
	if current.Version != input.ExpectedVersion {
		return AppearanceState{}, core.VersionConflict(current.Version)
	}
	if err = validateAppearance(current, input); err != nil {
		return AppearanceState{}, err
	}
	version, err := core.Add(current.Version, 1)
	if err != nil {
		return AppearanceState{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO appearance_state(id,version,character_key,face_wearable_key,head_wearable_key,upper_wearable_key,lower_wearable_key,shoes_wearable_key,back_wearable_key,
        head_color_key,upper_color_key,lower_color_key,shoes_color_key,back_color_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,character_key=excluded.character_key,
        face_wearable_key=excluded.face_wearable_key,head_wearable_key=excluded.head_wearable_key,upper_wearable_key=excluded.upper_wearable_key,
        lower_wearable_key=excluded.lower_wearable_key,shoes_wearable_key=excluded.shoes_wearable_key,back_wearable_key=excluded.back_wearable_key,
        head_color_key=excluded.head_color_key,upper_color_key=excluded.upper_color_key,lower_color_key=excluded.lower_color_key,
        shoes_color_key=excluded.shoes_color_key,back_color_key=excluded.back_color_key`, accountID, version, input.CharacterKey,
		input.FaceWearableKey, input.HeadWearableKey, input.UpperWearableKey, input.LowerWearableKey, input.ShoesWearableKey, input.BackWearableKey,
		input.HeadColorKey, input.UpperColorKey, input.LowerColorKey, input.ShoesColorKey, input.BackColorKey)
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
