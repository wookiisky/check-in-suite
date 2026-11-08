package shop

import (
	"context"
	"database/sql"
)

// ownershipCount aggregates order facts without making SQL grow with the asset catalog.
type ownershipCount struct {
	Owned bool  // Whether a permanent order exists.
	Count int64 // Number of currently owned instances.
}

// ownershipIdentity separates product quotes from the stable capability bought through them.
type ownershipIdentity struct {
	Product   string // Quote identity, empty for aggregate stable identities.
	Item      string // Stable island item identity.
	Character string // Stable character identity.
	Wearable  string // Stable wearable identity.
	Scene     string // Stable scene identity.
}

// stableOwnershipIdentity groups different offers for the same owned item.
func stableOwnershipIdentity(item Product) ownershipIdentity {
	switch item.Type {
	case TypeScene:
		return ownershipIdentity{Scene: item.SceneKey}
	case TypeCharacter:
		return ownershipIdentity{Character: item.CharacterKey}
	case TypeWearable:
		return ownershipIdentity{Wearable: item.WearableKey}
	}
	return ownershipIdentity{Item: item.IslandItemKey}
}

// addOwnership combines disjoint order groups while retaining permanent ownership.
func addOwnership(first, second ownershipCount) ownershipCount {
	return ownershipCount{Owned: first.Owned || second.Owned, Count: first.Count + second.Count}
}

// applyProductOwnership resolves all visible quotes with one grouped order query.
func applyProductOwnership(ctx context.Context, tx *sql.Tx, accountID int64, items []Product) error {
	counts := map[ownershipIdentity]ownershipCount{}
	rows, err := tx.QueryContext(ctx, `SELECT product_id,item_key_snapshot,character_key_snapshot,wearable_key_snapshot,scene_key_snapshot,type_snapshot,status,count(*) FROM purchases WHERE account_id=? GROUP BY product_id,item_key_snapshot,character_key_snapshot,wearable_key_snapshot,scene_key_snapshot,type_snapshot,status`, accountID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var product, item, body, wearable, scene, kind, status string
		var count int64
		if err := rows.Scan(&product, &item, &body, &wearable, &scene, &kind, &status, &count); err != nil {
			rows.Close()
			return err
		}
		value := ownershipCount{Owned: kind != TypeReward}
		if status == StatusOwned {
			value.Count = count
		}
		keys := []ownershipIdentity{{Product: product}}
		if item != "" {
			keys = append(keys, ownershipIdentity{Item: item}, ownershipIdentity{Product: product, Item: item})
		}
		if body != "" {
			keys = append(keys, ownershipIdentity{Character: body}, ownershipIdentity{Product: product, Character: body})
		}
		if wearable != "" {
			keys = append(keys, ownershipIdentity{Wearable: wearable}, ownershipIdentity{Product: product, Wearable: wearable})
		}
		if scene != "" {
			keys = append(keys, ownershipIdentity{Scene: scene}, ownershipIdentity{Product: product, Scene: scene})
		}
		for _, key := range keys {
			counts[key] = addOwnership(counts[key], value)
		}
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return readErr
	}
	for index := range items {
		item := &items[index]
		value := counts[ownershipIdentity{Product: item.ID}]
		stable := stableOwnershipIdentity(*item)
		if stable != (ownershipIdentity{}) {
			other := counts[stable]
			intersection := stable
			intersection.Product = item.ID
			value.Count += other.Count - counts[intersection].Count
			value.Owned = value.Owned || other.Owned
		}
		item.Owned, item.OwnedCount = value.Owned, value.Count
	}
	return nil
}
