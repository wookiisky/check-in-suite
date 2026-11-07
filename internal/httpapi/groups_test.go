package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/checkin"
)

// TestGroupsHTTP proves ownership and membership through serialized requests from three real sessions.
func TestGroupsHTTP(t *testing.T) {
	app, _, _ := checkinApplication(t)
	ctx := context.Background()
	for _, username := range []string{"second", "third"} {
		if err := app.Accounts.Initialize(ctx, username, username, "login-password", "manage-password"); err != nil {
			t.Fatal(err)
		}
	}
	reports := checkin.New(app.DB, app.Accounts, app.Config)
	reports.Now = app.Accounts.Now
	app.RegisterQueries(reports)
	group, err := app.Accounts.CreateGroup(ctx, "一起成长")
	if err != nil {
		t.Fatal(err)
	}
	a := loginGroupHTTPUser(t, app, "family")
	b := loginGroupHTTPUser(t, app, "second")
	c := loginGroupHTTPUser(t, app, "third")
	join := fmt.Sprintf(`{"group_id":%d,"password":"manage-password"}`, group.ID)
	if r := apiRequest(app, "GET", "/api/v1/groups", "", nil, ""); r.Code != 401 {
		t.Fatalf("anonymous groups: %d", r.Code)
	}
	if r := apiRequest(app, "POST", "/api/v1/groups/join", join, a.cookie, ""); r.Code != 403 {
		t.Fatalf("missing csrf: %d", r.Code)
	}
	if r := apiRequest(app, "POST", "/api/v1/groups/join", fmt.Sprintf(`{"group_id":%d,"password":"wrong-password"}`, group.ID), a.cookie, a.session.CSRFToken); r.Code != 422 {
		t.Fatalf("wrong password: %d %s", r.Code, r.Body)
	}
	for _, u := range []groupHTTPUser{a, b} {
		r := apiRequest(app, "POST", "/api/v1/groups/join", join, u.cookie, u.session.CSRFToken)
		if r.Code != 200 {
			t.Fatalf("join: %d %s", r.Code, r.Body)
		}
	}
	r := apiRequest(app, "GET", "/api/v1/groups", "", a.cookie, "")
	var state account.GroupState
	if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &state) != nil || len(state.Members) != 2 {
		t.Fatalf("members: %d %s", r.Code, r.Body)
	}
	var targetTask checkin.Task
	var targetRecord checkin.Record
	for index, u := range []groupHTTPUser{a, b} {
		r := checkinRequest(app, "POST", "/api/v1/management/tasks", fmt.Sprintf(`{"category_id":null,"name":"任务%d","icon_key":"book-v1","coin_reward":3,"diamond_reward":0,"daily_limit":1,"weekdays":[1,2,3,4,5,6,7],"enabled":true}`, index), u.cookie, u.session.CSRFToken, "same-task-key")
		var task checkin.Task
		if r.Code != 201 || json.Unmarshal(r.Body.Bytes(), &task) != nil {
			t.Fatalf("task: %d %s", r.Code, r.Body)
		}
		r = checkinRequest(app, "POST", "/api/v1/checkins", fmt.Sprintf(`{"task_id":%q,"expected_task_version":1,"expected_today":"2026-10-29","text":"完整记录","photo_media_id":null,"audio_media_id":null}`, task.ID), u.cookie, u.session.CSRFToken, "same-record-key")
		var created checkin.CreateResult
		if r.Code != 201 || json.Unmarshal(r.Body.Bytes(), &created) != nil || created.Wallet.Coins != 3 {
			t.Fatalf("record: %d %s", r.Code, r.Body)
		}
		if index == 1 {
			targetTask = task
			targetRecord = created.Checkin
		}
	}
	paths := []string{
		fmt.Sprintf("/api/v1/checkins?start_date=2026-10-01&end_date=2026-10-29&account_id=%d", b.session.Account.ID),
		fmt.Sprintf("/api/v1/calendar?month=2026-10&account_id=%d", b.session.Account.ID),
		fmt.Sprintf("/api/v1/stats?start_date=2026-10-01&end_date=2026-10-29&account_id=%d", b.session.Account.ID),
		fmt.Sprintf("/api/v1/group-today?account_id=%d", b.session.Account.ID),
	}
	for _, path := range paths {
		r := apiRequest(app, "GET", path, "", a.cookie, "")
		if r.Code != 200 {
			t.Fatalf("same group %s: %d %s", path, r.Code, r.Body)
		}
		r = apiRequest(app, "GET", path, "", c.cookie, "")
		if r.Code != 403 {
			t.Fatalf("outside group %s: %d %s", path, r.Code, r.Body)
		}
	}
	r = apiRequest(app, "GET", paths[0], "", a.cookie, "")
	var records checkin.RecordPage
	if json.Unmarshal(r.Body.Bytes(), &records) != nil || len(records.Items) != 1 || records.Items[0].TaskID != targetTask.ID || records.Items[0].CanEdit || records.Items[0].CanDelete {
		t.Fatalf("member records not read only: %s", r.Body)
	}
	for _, path := range []string{"/api/v1/checkins/", "/api/v1/management/checkins/"} {
		r := apiRequest(app, "DELETE", path+targetRecord.ID, `{"expected_version":1}`, a.cookie, a.session.CSRFToken)
		if r.Code != 404 {
			t.Fatalf("cross account delete: %d %s", r.Code, r.Body)
		}
	}
	for _, query := range []string{"account_id=invalid", "account_id=0", "account_id=-1", "account_id=9007199254740992"} {
		r := apiRequest(app, "GET", "/api/v1/group-today?"+query, "", a.cookie, "")
		if r.Code != 400 {
			t.Fatalf("invalid target %s: %d %s", query, r.Code, r.Body)
		}
	}
	r = apiRequest(app, "POST", "/api/v1/groups/leave", `{"password":"manage-password"}`, b.cookie, b.session.CSRFToken)
	if r.Code != 200 {
		t.Fatalf("leave: %d %s", r.Code, r.Body)
	}
	for _, path := range paths {
		r := apiRequest(app, "GET", path, "", a.cookie, "")
		if r.Code != 403 {
			t.Fatalf("read after leave %s: %d %s", path, r.Code, r.Body)
		}
	}
}

// TestReadRejectsChangedBrowserSession prevents an old tab from accepting a new account's cookie identity.
func TestReadRejectsChangedBrowserSession(t *testing.T) {
	app, _, _ := checkinApplication(t)
	if err := app.Accounts.Initialize(context.Background(), "second", "second", "login-password", "manage-password"); err != nil {
		t.Fatal(err)
	}
	first := loginGroupHTTPUser(t, app, "family")
	second := loginGroupHTTPUser(t, app, "second")
	for _, path := range []string{"/api/v1/session", "/api/v1/camp", "/api/v1/groups"} {
		stale := apiRequest(app, "GET", path, "", second.cookie, first.session.CSRFToken)
		if stale.Code != 401 {
			t.Fatalf("stale page read %s: %d %s", path, stale.Code, stale.Body)
		}
		valid := apiRequest(app, "GET", path, "", second.cookie, second.session.CSRFToken)
		if valid.Code != 200 {
			t.Fatalf("current page read %s: %d %s", path, valid.Code, valid.Body)
		}
	}
	// Mutation errors retain the existing CSRF contract rather than being treated as login expiry.
	invalidWrite := apiRequest(app, "PATCH", "/api/v1/account/preferences", `{"effects_enabled":false}`, second.cookie, first.session.CSRFToken)
	if invalidWrite.Code != 403 {
		t.Fatalf("write csrf response changed: %d %s", invalidWrite.Code, invalidWrite.Body)
	}
}
