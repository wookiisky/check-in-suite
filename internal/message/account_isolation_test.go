package message

import (
	"context"
	"testing"
)

// TestMessagesStayPrivate proves identical request keys, lists and deletes remain local to each account.
func TestMessagesStayPrivate(t *testing.T) {
	f := setupMessages(t)
	ctx := context.Background()
	if err := f.Accounts.Initialize(ctx, "another", "另一位", "login-password", "manage-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.Accounts.Login(ctx, "another", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.Accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.DB.Exec("INSERT INTO groups(id,name) VALUES(1,'same')"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Service.DB.Exec("UPDATE accounts SET group_id=1"); err != nil {
		t.Fatal(err)
	}
	first, err := f.Service.Create(ctx, f.Principal, "same-key", CreateInput{Text: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.Service.Create(ctx, other, "same-key", CreateInput{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("accounts reused a message identity")
	}
	if err := f.Service.Delete(ctx, other, first.ID); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		Owner bool
		ID    string
	}{{true, first.ID}, {false, second.ID}} {
		p := other
		if item.Owner {
			p = f.Principal
		}
		page, err := f.Service.List(ctx, p, "", 10)
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != item.ID {
			t.Fatalf("owner=%v page=%+v err=%v", item.Owner, page, err)
		}
	}
}
