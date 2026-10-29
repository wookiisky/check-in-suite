package shop

import (
	"context"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// SetBaseAvatar selects a free human form without changing any saved wearable slots.
func (s *Service) SetBaseAvatar(ctx context.Context, p account.Principal, key string) (Equipment, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Equipment{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return Equipment{}, err
	}
	asset, ok := assets.Get(key)
	if !ok || asset.Kind != assets.KindAvatar || !asset.Free {
		return Equipment{}, core.Invalid("asset_key", "INVALID_ASSET")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET base_avatar_key=?,avatar_purchase_id=NULL,updated_at=? WHERE id=1", key, now.UnixMilli()); err != nil {
		return Equipment{}, err
	}
	result, err := ReadEquipment(ctx, tx)
	if err != nil {
		return Equipment{}, err
	}
	return result, tx.Commit()
}
