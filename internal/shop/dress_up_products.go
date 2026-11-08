package shop

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"sync"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// dressUpOfferDefaults belongs to the shop and supplies launch terms for selected catalog entries.
type dressUpOfferDefaults struct {
	Name         string `json:"name"`          // Optional offer display name distinct from the wardrobe name.
	CoinPrice    int64  `json:"coin_price"`    // Initial coin price.
	DiamondPrice int64  `json:"diamond_price"` // Initial diamond price.
}

// dressUpOfferBinding holds a sellable catalog item and the versioned artwork used at confirmation.
type dressUpOfferBinding struct {
	Key       string // Stable body or wearable identity.
	Name      string // Default display name from the catalog.
	Thumbnail string // Versioned artwork shown at purchase.
	Model     string // Versioned model received on purchase.
}

// dressUpDisplay is the read-only catalog projection used by shop rows and filters.
type dressUpDisplay struct {
	Thumbnail string // Versioned artwork for the current release.
	Provider  string // Official source provider.
	PackKey   string // Official source pack.
	Slot      string // Wearable slot; empty for bodies.
}

// dressUpDisplays indexes only the scalar facts needed on shop read paths.
var dressUpDisplays = sync.OnceValue(func() map[string]map[string]dressUpDisplay {
	bodies, wearables := map[string]dressUpDisplay{}, map[string]dressUpDisplay{}
	for _, body := range character.Definitions() {
		bodies[body.Key] = dressUpDisplay{Thumbnail: body.ThumbnailAssetKey, Provider: body.Provider, PackKey: body.PackKey}
	}
	for _, wearable := range character.Wearables() {
		wearables[wearable.Key] = dressUpDisplay{Thumbnail: wearable.ThumbnailAssetKey, Provider: wearable.Provider, PackKey: wearable.PackKey, Slot: string(wearable.Slot)}
	}
	return map[string]map[string]dressUpDisplay{TypeCharacter: bodies, TypeWearable: wearables}
})

// syncDressUpOffers adds catalog items, retires removed listings and preserves managed terms.
func syncDressUpOffers(ctx context.Context, tx *sql.Tx, accountID, now int64, kind string, bindings []dressUpOfferBinding, defaults map[string]dressUpOfferDefaults) error {
	active := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		active = append(active, binding.Key)
		terms, enabled := defaults[binding.Key]
		if terms.Name == "" {
			terms.Name = binding.Name
		}
		var body, wearable string
		if kind == TypeCharacter {
			body = binding.Key
		} else {
			wearable = binding.Key
		}
		checksum := sha256.Sum256([]byte(binding.Thumbnail + "\x00" + binding.Model))
		revision := hex.EncodeToString(checksum[:])
		_, err := tx.ExecContext(ctx, `INSERT INTO products(id,account_id,type,name,asset_key,character_key,wearable_key,coin_price,diamond_price,enabled,created_at,updated_at,catalog_revision)
			VALUES(?,?,?,?,'',?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET catalog_revision=excluded.catalog_revision,version=products.version+1,updated_at=excluded.updated_at
			WHERE products.catalog_revision IS NOT excluded.catalog_revision`,
			catalogProductID(accountID, kind+"-offer-"+binding.Key), accountID, kind, terms.Name, body, wearable, terms.CoinPrice, terms.DiamondPrice, enabled, now, now, revision)
		if err != nil {
			return err
		}
	}
	keys, err := json.Marshal(active)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE products SET catalog_revision=NULL,version=version+1,updated_at=?
		WHERE account_id=? AND type=? AND catalog_revision IS NOT NULL
		AND CASE type WHEN 'character' THEN character_key ELSE wearable_key END NOT IN (SELECT value FROM json_each(?))`,
		now, accountID, kind, string(keys))
	return err
}
