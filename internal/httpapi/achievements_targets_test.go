package httpapi

import (
	"reflect"
	"testing"
)

// TestAchievementTargetsRemainReadableWithoutManagement checks actual JSON across rule and camp reads.
func TestAchievementTargetsRemainReadableWithoutManagement(t *testing.T) {
	f := newAchievementHTTPFixture(t)
	all := f.success(f.request("POST", "/management/achievements", f.rule("全部任务成就", "count", "all"), "all-targets"), 201)
	category, present := all["category"]
	if !present || category != nil || !reflect.DeepEqual(all["tasks"], []any{}) {
		t.Fatalf("all scope must return explicit null category and empty tasks: %+v", all)
	}

	c := f.success(f.request("POST", "/management/categories", map[string]any{"name": "原类别"}, "target-category"), 201)
	task := f.task(c["id"])
	taskID := task["id"].(string)
	f.checkin(taskID, "target-record")
	categoryRule := f.rule("类别成就", "count", "category")
	categoryRule["category_id"] = c["id"]
	categoryBadge := f.success(f.request("POST", "/management/achievements", categoryRule, "category-targets"), 201)
	taskRule := f.rule("任务成就", "count", "tasks")
	taskRule["task_ids"] = []string{taskID}
	taskBadge := f.success(f.request("POST", "/management/achievements", taskRule, "task-targets"), 201)
	wantCategory := map[string]any{"id": c["id"], "name": "原类别", "deleted": false}
	wantTasks := []any{map[string]any{"id": taskID, "name": task["name"], "category_id": c["id"], "deleted": false}}
	assertAchievementTargets(t, categoryBadge, wantCategory, []any{})
	assertAchievementTargets(t, taskBadge, nil, wantTasks)
	categoryID, taskBadgeID := categoryBadge["id"].(string), taskBadge["id"].(string)

	f.success(f.request("PATCH", "/management/categories/"+c["id"].(string), map[string]any{"name": "更新类别", "sort_order": 0, "expected_version": 1}, ""), 200)
	f.success(f.request("PATCH", "/management/tasks/"+taskID, map[string]any{"category_id": c["id"], "name": "更新任务", "icon_key": "book-v1", "coin_reward": 7, "diamond_reward": 3, "daily_limit": 3, "weekdays": []int{1, 2, 3, 4, 5, 6, 7}, "enabled": true, "expected_version": 1}, ""), 200)
	wantCategory["name"] = "更新类别"
	wantTasks[0].(map[string]any)["name"] = "更新任务"
	categoryRule["expected_version"] = 1
	assertAchievementTargets(t, f.success(f.request("PATCH", "/management/achievements/"+categoryID, categoryRule, ""), 200), wantCategory, []any{})
	assertAchievementTargets(t, f.success(f.request("POST", "/management/achievements", taskRule, "task-targets"), 201), nil, wantTasks)

	f.success(f.request("DELETE", "/management/tasks/"+taskID, map[string]any{"expected_version": 2}, ""), 204)
	f.success(f.request("DELETE", "/management/categories/"+c["id"].(string), map[string]any{"expected_version": 2}, ""), 204)
	wantCategory["deleted"] = true
	wantTasks[0].(map[string]any)["deleted"] = true
	f.success(f.request("POST", "/management/lock", nil, ""), 204)
	assertAchievementTargets(t, f.item(categoryID), wantCategory, []any{})
	assertAchievementTargets(t, f.item(taskBadgeID), nil, wantTasks)
	assertAchievementTargets(t, f.success(f.request("PUT", "/achievements/"+categoryID+"/equipment", map[string]any{"equipped": true}, ""), 200), wantCategory, []any{})
	assertAchievementTargets(t, f.success(f.request("PUT", "/achievements/"+taskBadgeID+"/equipment", map[string]any{"equipped": true}, ""), 200), nil, wantTasks)
	camp := f.success(f.request("GET", "/camp", nil, ""), 200)
	badges := camp["achievements"].([]any)
	if len(badges) != 2 {
		t.Fatalf("camp lost equipped scoped achievements: %+v", badges)
	}
	for _, value := range badges {
		badge := value.(map[string]any)
		if badge["id"] == categoryID {
			assertAchievementTargets(t, badge, wantCategory, []any{})
		} else {
			assertAchievementTargets(t, badge, nil, wantTasks)
		}
	}
}

// assertAchievementTargets checks retained display identities against the actual wire response.
func assertAchievementTargets(t *testing.T, item map[string]any, category any, tasks []any) {
	t.Helper()
	if !reflect.DeepEqual(item["category"], category) || !reflect.DeepEqual(item["tasks"], tasks) {
		t.Fatalf("achievement targets: category=%+v tasks=%+v; want category=%+v tasks=%+v", item["category"], item["tasks"], category, tasks)
	}
}
