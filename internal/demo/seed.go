// Package demo prepares an explicit, repeatable household for testing on an empty database.
package demo

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

const Version = 1 // Completed dataset revision understood by this executable.

//go:embed settings.json
var settingsJSON []byte

// settings holds demo content separately from the data-generation rules.
type settings struct {
	Username           string             `json:"username"`            // Demo login name.
	Password           string             `json:"password"`            // Deliberately short test credential.
	ManagementPassword string             `json:"management_password"` // Demo maintenance credential.
	DisplayName        string             `json:"display_name"`        // Initial public profile name.
	Categories         []string           `json:"categories"`          // Task category display names.
	TaskName           string             `json:"task_name"`           // Task name format using the controlled asset name.
	AchievementName    string             `json:"achievement_name"`    // Achievement name format.
	ProductDescription string             `json:"product_description"` // Managed offer description.
	CheckinText        []string           `json:"checkin_text"`        // Alternating record examples.
	Messages           []string           `json:"messages"`            // Family message examples.
	HistoryDays        int                `json:"history_days"`        // Inclusive number of Taipei business dates.
	CoinReward         int64              `json:"coin_reward"`         // Reward per seeded completion.
	DiamondReward      int64              `json:"diamond_reward"`      // Diamond reward per completion.
	CoinPrice          int64              `json:"coin_price"`          // Default demonstration coin price.
	DiamondPrice       int64              `json:"diamond_price"`       // Default demonstration diamond price.
	DailyLimit         int                `json:"daily_limit"`         // Leaves room to complete seeded tasks again today.
	Metrics            []string           `json:"metrics"`             // Achievement metric examples.
	Targets            []int64            `json:"targets"`             // Mixed achieved and future thresholds.
	OwnedAssets        []string           `json:"owned_assets"`        // Offers with example purchase facts.
	Placements         []island.Placement `json:"placements"`          // Valid initial island layout with asset-backed slots.
}

// Result describes committed changes; skipped runs deliberately do not regenerate counts.
type Result struct {
	Skipped      bool `json:"skipped"`      // A complete dataset was already present.
	Tasks        int  `json:"tasks"`        // Created task definitions.
	Products     int  `json:"products"`     // Created managed offers.
	Achievements int  `json:"achievements"` // Created achievement rules.
	Checkins     int  `json:"checkins"`     // Created completion facts.
	Purchases    int  `json:"purchases"`    // Created orders, including redeemed rewards.
}

// Seed installs artwork and commits one complete dataset, never replacing an existing household.
func Seed(ctx context.Context, db *sql.DB, cfg config.Config) (Result, error) {
	var content settings
	if err := json.Unmarshal(settingsJSON, &content); err != nil {
		return Result{}, err
	}
	complete, occupied, err := inspect(ctx, db)
	if err != nil {
		return Result{}, err
	}
	if complete && occupied {
		return Result{Skipped: true}, nil
	}
	if complete || occupied {
		return Result{}, core.Fail(409, "DEMO_REQUIRES_EMPTY_DATABASE")
	}
	artwork := assets.New(cfg.AssetsDirectory)
	if err := artwork.Install(); err != nil {
		return Result{}, err
	}
	items, err := artwork.List()
	if err != nil {
		return Result{}, err
	}
	// Only this maintenance operation accepts the four-character test credentials.
	testConfig := cfg
	testConfig.Limits.PasswordMin = 4
	accounts := account.New(db, testConfig)
	now := accounts.Now().In(cfg.Location)
	result := Result{}
	err = accounts.InitializeWith(ctx, content.Username, content.DisplayName, content.Password, content.ManagementPassword, func(tx *sql.Tx) error {
		if err := requireEmptyBusiness(ctx, tx); err != nil {
			return err
		}
		if err := seedDefinitions(ctx, tx, items, content, now, &result); err != nil {
			return err
		}
		if err := seedHistory(ctx, tx, items, content, now, &result); err != nil {
			return err
		}
		if err := seedPurchases(ctx, tx, content, now, &result); err != nil {
			return err
		}
		if err := achievement.Reconcile(ctx, tx, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE achievements SET equipped=1 WHERE id=(SELECT id FROM achievements WHERE qualified=1 ORDER BY id LIMIT 1)`); err != nil {
			return err
		}
		for index, text := range content.Messages {
			if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,text,created_at) VALUES(?,?,?)`, core.ID(), text, now.Add(-time.Duration(index)*time.Hour).UnixMilli()); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO demo_seeds(version,completed_at) VALUES(?,?)`, Version, now.UnixMilli())
		return err
	})
	if err != nil {
		// Another initializer can win while password hashing occurs outside the database lock.
		var domain *core.Error
		if errors.As(err, &domain) && domain.Code == "ACCOUNT_EXISTS" {
			complete, _, checkErr := inspect(ctx, db)
			if checkErr != nil {
				return Result{}, checkErr
			}
			if complete {
				return Result{Skipped: true}, nil
			}
			return Result{}, core.Fail(409, "DEMO_REQUIRES_EMPTY_DATABASE")
		}
		return Result{}, err
	}
	return result, nil
}

// inspect uses the persisted marker instead of assuming that a matching username proves ownership.
func inspect(ctx context.Context, db *sql.DB) (bool, bool, error) {
	var complete, occupied bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM demo_seeds WHERE version=?),EXISTS(SELECT 1 FROM accounts)`, Version).Scan(&complete, &occupied)
	return complete, occupied, err
}

// requireEmptyBusiness refuses orphaned or partially managed data rather than merging it into a demo.
func requireEmptyBusiness(ctx context.Context, tx *sql.Tx) error {
	var occupied bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM categories UNION ALL SELECT 1 FROM tasks UNION ALL SELECT 1 FROM products UNION ALL SELECT 1 FROM achievements UNION ALL SELECT 1 FROM media_files UNION ALL SELECT 1 FROM messages UNION ALL SELECT 1 FROM island_state UNION ALL SELECT 1 FROM demo_seeds)`).Scan(&occupied)
	if err != nil {
		return err
	}
	if occupied {
		return core.Fail(409, "DEMO_REQUIRES_EMPTY_DATABASE")
	}
	return nil
}
