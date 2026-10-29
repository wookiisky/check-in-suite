package achievement

import (
	"slices"
	"sort"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Rule is one explicit achievement condition; there are no nested expressions.
type Rule struct {
	Metric     string   // count, days, streak, coins or diamonds.
	Scope      string   // all, category or tasks.
	CategoryID *string  // Current category identity when Scope is category.
	TaskIDs    []string // Stable task identities when Scope is tasks.
	Target     int64    // Required progress, interpreted by the persistence boundary.
	WindowDays *int     // Optional inclusive number of natural days for the historical best.
}

// TaskFact retains historical tasks, including deleted tasks and their last category.
type TaskFact struct {
	ID         string     // Stable task identity shared with effective records.
	CategoryID *string    // Current category, or the last category before task deletion.
	Schedules  []Schedule // Date-effective frequency history, in any input order.
}

// Schedule records one date-effective change to the task's expected appearances.
type Schedule struct {
	StartDate   string // Inclusive Taipei business date of the known schedule version.
	WeekdayMask int    // Monday occupies bit zero and Sunday bit six.
	Enabled     bool   // Disabled history stops new obligations without removing older ones.
}

// RecordFact contains only effective check-in facts, retaining their original rewards.
type RecordFact struct {
	TaskID   string // Source task; a task's later deletion does not discard this fact.
	Date     string // Taipei business date, rather than the backfill operation timestamp.
	Coins    int64  // Original coin reward; spending is outside achievement progress.
	Diamonds int64  // Original diamond reward.
}

// dailyFact groups effective records once for both numerical and consecutive metrics.
type dailyFact struct {
	date      time.Time       // Parsed midnight used for natural-day windows.
	count     int64           // Number of effective records on this date.
	coins     int64           // Sum of original coin rewards, capped at the public integer maximum.
	diamonds  int64           // Sum of original diamond rewards, capped at the public integer maximum.
	completed map[string]bool // Tasks with at least one effective completion on this date.
}

// Evaluate calculates historical best progress without mutating facts or consulting a clock.
func Evaluate(rule Rule, tasks []TaskFact, records []RecordFact, today string) int64 {
	selected := make(map[string]TaskFact)
	for _, task := range tasks {
		matches := rule.Scope == "all" ||
			(rule.Scope == "category" && rule.CategoryID != nil && task.CategoryID != nil && *rule.CategoryID == *task.CategoryID) ||
			(rule.Scope == "tasks" && slices.Contains(rule.TaskIDs, task.ID))
		if !matches {
			continue
		}
		// Callers own the input slices; sorting a copy makes replay evaluation deterministic.
		task.Schedules = slices.Clone(task.Schedules)
		sort.SliceStable(task.Schedules, func(i, j int) bool { return task.Schedules[i].StartDate < task.Schedules[j].StartDate })
		selected[task.ID] = task
	}
	days := make(map[string]*dailyFact)
	for _, record := range records {
		if _, matches := selected[record.TaskID]; !matches || record.Date > today {
			continue
		}
		day := days[record.Date]
		if day == nil {
			date, err := core.ParseDate(record.Date)
			if err != nil {
				continue
			}
			day = &dailyFact{date: date, completed: make(map[string]bool)}
			days[record.Date] = day
		}
		day.count = cappedSum(day.count, 1)
		day.coins = cappedSum(day.coins, record.Coins)
		day.diamonds = cappedSum(day.diamonds, record.Diamonds)
		day.completed[record.TaskID] = true
	}
	if len(days) == 0 {
		return 0
	}
	dates := make([]string, 0, len(days))
	for date := range days {
		dates = append(dates, date)
	}
	slices.Sort(dates)
	if rule.Metric == "streak" {
		return bestStreak(rule, selected, days, dates)
	}
	return bestTotal(rule, days, dates)
}

// cappedSum keeps a nonnegative progress result exactly representable by JSON clients.
func cappedSum(left, right int64) int64 {
	if right >= core.MaxInteger-left {
		return core.MaxInteger
	}
	return left + right
}

// metricValue maps one supported numerical metric onto a day's facts.
func metricValue(metric string, day *dailyFact) int64 {
	switch metric {
	case "count":
		return day.count
	case "days":
		return 1
	case "coins":
		return day.coins
	case "diamonds":
		return day.diamonds
	default:
		return 0
	}
}

// bestTotal slides across natural days, including both ends without requiring daily records.
func bestTotal(rule Rule, days map[string]*dailyFact, dates []string) int64 {
	var total, best int64
	left := 0
	for right, date := range dates {
		day := days[date]
		if rule.WindowDays != nil {
			for left < right && (day.date.Unix()-days[dates[left]].date.Unix())/86400 >= int64(*rule.WindowDays) {
				total -= metricValue(rule.Metric, days[dates[left]])
				left++
			}
		}
		total = cappedSum(total, metricValue(rule.Metric, day))
		if total == core.MaxInteger {
			// This is already the largest observable historical best, so no saturated subtraction follows.
			return total
		}
		best = max(best, total)
	}
	return best
}

// planned checks the latest effective frequency without applying it to earlier dates.
func planned(task TaskFact, date string, weekday int) bool {
	for index := len(task.Schedules) - 1; index >= 0; index-- {
		schedule := task.Schedules[index]
		if schedule.StartDate <= date {
			return schedule.Enabled && schedule.WeekdayMask&(1<<weekday) != 0
		}
	}
	return false
}

// bestStreak counts completed planned days; an empty schedule neither advances nor breaks a run.
func bestStreak(rule Rule, tasks map[string]TaskFact, days map[string]*dailyFact, dates []string) int64 {
	first, last := days[dates[0]].date, days[dates[len(dates)-1]].date
	var best int64
	completedDates := make([]int64, 0, len(dates))
	left := 0
	for date := first; !date.After(last); date = date.AddDate(0, 0, 1) {
		key := date.Format(time.DateOnly)
		day := days[key]
		weekday := (int(date.Weekday()) + 6) % 7
		hasPlan, complete := false, true
		for id, task := range tasks {
			done := day != nil && day.completed[id]
			// Existing backfill accepts current schedules, even before task creation. A saved completion
			// therefore counts as one actual appearance, while every other historical obligation remains.
			if !done && !planned(task, key, weekday) {
				continue
			}
			hasPlan = true
			if !done {
				complete = false
				break
			}
		}
		if !hasPlan {
			continue
		}
		if !complete {
			completedDates = completedDates[:0]
			left = 0
			continue
		}
		ordinal := date.Unix() / 86400
		completedDates = append(completedDates, ordinal)
		if rule.WindowDays != nil {
			for left < len(completedDates) && ordinal-completedDates[left] >= int64(*rule.WindowDays) {
				left++
			}
		}
		best = max(best, int64(len(completedDates)-left))
	}
	return best
}
