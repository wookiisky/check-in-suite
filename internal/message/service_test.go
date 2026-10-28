package message

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// TestMessageLifecycle checks normalized content, immutable replay identities and deletion without resurrection.
func TestMessageLifecycle(t *testing.T) {
	f := setupMessages(t)
	ctx := context.Background()
	input := CreateInput{Text: "  一起完成今天的任务  "}
	created, err := f.Service.Create(ctx, f.Principal, "first", input)
	if err != nil || created.Text != strings.TrimSpace(input.Text) {
		t.Fatalf("create: %+v %v", created, err)
	}
	replayed, err := f.Service.Create(ctx, f.Principal, "first", input)
	if err != nil || replayed != created {
		t.Fatalf("replay: %+v %v", replayed, err)
	}
	_, err = f.Service.Create(ctx, f.Principal, "first", CreateInput{Text: "不同的留言"})
	requireCode(t, err, "IDEMPOTENCY_CONFLICT")
	var receipt string
	if err := f.Service.DB.QueryRow("SELECT response_json FROM idempotency_requests WHERE operation='message.create'").Scan(&receipt); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(receipt, created.Text) {
		t.Fatal("private message duplicated in receipt")
	}
	if err := f.Service.Delete(ctx, f.Principal, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.Service.Delete(ctx, f.Principal, created.ID); err != nil {
		t.Fatalf("repeat delete: %v", err)
	}
	replayed, err = f.Service.Create(ctx, f.Principal, "first", input)
	if err != nil || replayed.ID != created.ID {
		t.Fatalf("deleted receipt: %+v %v", replayed, err)
	}
	page, err := f.Service.List(ctx, f.Principal, "", 50)
	if err != nil || page.Items == nil || len(page.Items) != 0 {
		t.Fatalf("replay resurrected message: %+v %v", page, err)
	}
	if err := f.Accounts.Logout(ctx, f.Principal); err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.Create(ctx, f.Principal, "first", input)
	requireCode(t, err, "SESSION_REQUIRED")
}

// TestMessageLimitsAndPagination exercises Unicode code points and identical timestamps across pages.
func TestMessageLimitsAndPagination(t *testing.T) {
	f := setupMessages(t)
	ctx := context.Background()
	for _, text := range []string{"", " \t\n", strings.Repeat("🙂", 501)} {
		_, err := f.Service.Create(ctx, f.Principal, core.ID(), CreateInput{Text: text})
		requireCode(t, err, "INVALID_REQUEST")
	}
	for _, text := range []string{strings.Repeat("🙂", 500), "第二条", "第三条"} {
		if _, err := f.Service.Create(ctx, f.Principal, core.ID(), CreateInput{Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := f.Service.List(ctx, f.Principal, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatal("duplicate page item")
			}
			seen[item.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("pagination omitted messages: %d", len(seen))
	}
	for _, limit := range []int{0, 101} {
		_, err := f.Service.List(ctx, f.Principal, "", limit)
		requireCode(t, err, "INVALID_REQUEST")
	}
	_, err := f.Service.List(ctx, f.Principal, "not-a-cursor", 50)
	requireCode(t, err, "INVALID_REQUEST")
}

// TestMessageConcurrentReplay starts two independent connections behind one real SQLite write lock.
func TestMessageConcurrentReplay(t *testing.T) {
	f := setupMessages(t)
	ctx := context.Background()
	other, err := storage.Open(ctx, f.Path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	writer := New(other, f.Service.Config)
	writer.Now = f.Service.Now
	blocker, err := storage.Open(ctx, f.Path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	lock, err := blocker.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback()
	type outcome struct {
		message Message
		err     error
	}
	started := make(chan struct{}, 2)
	results := make(chan outcome, 2)
	for _, service := range []*Service{f.Service, writer} {
		go func(s *Service) {
			started <- struct{}{}
			value, err := s.Create(ctx, f.Principal, "same-command", CreateInput{Text: "一次留言"})
			results <- outcome{value, err}
		}(service)
	}
	<-started
	<-started
	select {
	case result := <-results:
		t.Fatalf("writer bypassed held write lock: %+v", result)
	case <-time.After(20 * time.Millisecond):
	}
	if err := lock.Commit(); err != nil {
		t.Fatal(err)
	}
	one, two := <-results, <-results
	if one.err != nil || two.err != nil || one.message.ID != two.message.ID {
		t.Fatalf("concurrent replay: %+v %+v", one, two)
	}
	var count int
	if err := f.Service.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 1 {
		t.Fatalf("message count %d %v", count, err)
	}
}

// TestMessageReceiptFailureRollsBack proves receipt failure cannot leave an unrepeatable created note.
func TestMessageReceiptFailureRollsBack(t *testing.T) {
	f := setupMessages(t)
	ctx := context.Background()
	if _, err := f.Service.DB.Exec("CREATE TRIGGER reject_message_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.operation='message.create' BEGIN SELECT RAISE(ABORT,'injected failure'); END"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.Create(ctx, f.Principal, "rollback", CreateInput{Text: "不会部分提交"}); err == nil {
		t.Fatal("receipt failure reported success")
	}
	var count int
	if err := f.Service.DB.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial note persisted: %d %v", count, err)
	}
	if _, err := f.Service.DB.Exec("DROP TRIGGER reject_message_receipt"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.Create(ctx, f.Principal, "rollback", CreateInput{Text: "不会部分提交"}); err != nil {
		t.Fatal(err)
	}
}
