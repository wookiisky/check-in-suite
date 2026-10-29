package demo

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/wookiisky/check-in-suite/internal/achievement"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// seedDefinitions maps every current artwork kind to its supported business use.
func seedDefinitions(ctx context.Context, tx *sql.Tx, items []assets.Asset, content settings, now time.Time, result *Result) error {
	createdAt := now.AddDate(0, 0, -content.HistoryDays+1).UnixMilli()
	for index, name := range content.Categories {
		if _, err := tx.ExecContext(ctx, `INSERT INTO categories(id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)`, fmt.Sprintf("demo-category-%d", index), name, index, createdAt, now.UnixMilli()); err != nil {
			return err
		}
	}
	for _, item := range items {
		if item.Free || item.Kind == assets.KindCharacterPart {
			continue
		}
		switch item.Kind {
		case assets.KindIcon:
			id := "demo-task-" + item.Key
			_, err := tx.ExecContext(ctx, `INSERT INTO tasks(id,category_id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,127,1,?,?)`, id, fmt.Sprintf("demo-category-%d", result.Tasks%len(content.Categories)), fmt.Sprintf(content.TaskName, item.Name), item.Key, content.CoinReward, content.DiamondReward, content.DailyLimit, createdAt, now.UnixMilli())
			if err != nil {
				return err
			}
			if err := achievement.RecordSchedule(ctx, tx, id, core.Today(now.AddDate(0, 0, -content.HistoryDays+1)), 127, true); err != nil {
				return err
			}
			result.Tasks++
		case assets.KindBadge:
			_, err := tx.ExecContext(ctx, `INSERT INTO achievements(id,name,asset_key,metric,scope,target,enabled,created_at,updated_at) VALUES(?,?,?,?,'all',?,1,?,?)`, "demo-achievement-"+item.Key, fmt.Sprintf(content.AchievementName, item.Name), item.Key, content.Metrics[result.Achievements%len(content.Metrics)], content.Targets[result.Achievements%len(content.Targets)], createdAt, now.UnixMilli())
			if err != nil {
				return err
			}
			result.Achievements++
		default:
			coins, diamonds := content.CoinPrice, content.DiamondPrice
			if definition, ok := island.ForAsset(item.Key); ok && !definition.CatalogOnly {
				coins, diamonds = definition.CoinPrice, definition.DiamondPrice
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO products(id,type,name,asset_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)`, "demo-product-"+item.Key, string(item.Kind), item.Name, item.Key, content.ProductDescription, coins, diamonds, createdAt, now.UnixMilli())
			if err != nil {
				return err
			}
			result.Products++
		}
	}
	return nil
}

// seedHistory creates dated reward snapshots and uses the real ledger for every grant.
func seedHistory(ctx context.Context, tx *sql.Tx, items []assets.Asset, content settings, now time.Time, result *Result) error {
	tasks := []assets.Asset{}
	for _, item := range items {
		if item.Kind == assets.KindIcon {
			tasks = append(tasks, item)
		}
	}
	for day := content.HistoryDays - 1; day >= 0; day-- {
		at := now.AddDate(0, 0, -day)
		source := "backfill"
		if day == 0 {
			source = "today"
		}
		for index := 0; index < 3; index++ {
			item := tasks[(day*3+index)%len(tasks)]
			id := core.ID()
			_, err := tx.ExecContext(ctx, `INSERT INTO checkins(id,task_id,business_date,task_name_snapshot,task_icon_snapshot,coin_reward_snapshot,diamond_reward_snapshot,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, "demo-task-"+item.Key, core.Today(at), fmt.Sprintf(content.TaskName, item.Name), item.Key, content.CoinReward, content.DiamondReward, content.CheckinText[(day+index)%len(content.CheckinText)], source, at.UnixMilli(), at.UnixMilli())
			if err != nil {
				return err
			}
			if _, err := wallet.Apply(ctx, tx, wallet.Event{Type: wallet.CheckinGrant, ResourceID: id, Coins: content.CoinReward, Diamonds: content.DiamondReward, At: at}); err != nil {
				return err
			}
			result.Checkins++
		}
	}
	return nil
}
