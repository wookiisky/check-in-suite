package account

import (
	"context"
	"database/sql"
	"testing"
)

// groupAccount creates an independent account and resolves its real persisted session.
func groupAccount(t *testing.T, s *Service, username string) (string, Principal) {
	t.Helper()
	ctx := context.Background()
	if err := s.Initialize(ctx, username, username, "login password", username+" management"); err != nil {
		t.Fatal(err)
	}
	token, _, err := s.Login(ctx, username, "login password")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	return token, p
}

// readMember checks authorization against a real transaction rather than browser state.
func readMember(t *testing.T, s *Service, p Principal, target int64) error {
	t.Helper()
	tx, err := s.DB.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	return AuthorizeRead(context.Background(), tx, p, target, s.Now())
}

// TestGroupsControlReadAccess exercises membership, independent credentials and immediate revocation.
func TestGroupsControlReadAccess(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	s.hash = func(value string) (string, error) { return value, nil }
	s.verify = func(hash, password string) bool { return hash == password }
	_, a := groupAccount(t, s, "alice")
	_, b := groupAccount(t, s, "bob")
	_, c := groupAccount(t, s, "carol")
	if a.AccountID == b.AccountID || a.AccountID == 0 {
		t.Fatal("accounts must have independent IDs")
	}
	group, err := s.CreateGroup(ctx, "伙伴")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateGroup(ctx, "其他")
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, readMember(t, s, a, b.AccountID), "GROUP_ACCESS_DENIED")
	if err = readMember(t, s, a, a.AccountID); err != nil {
		t.Fatal(err)
	}
	_, err = s.JoinGroup(ctx, a, group.ID, "bob management")
	assertCode(t, err, "INVALID_CREDENTIALS")
	state, err := s.JoinGroup(ctx, a, group.ID, "alice management")
	if err != nil || state.CurrentGroup == nil || state.CurrentGroup.ID != group.ID || len(state.Members) != 1 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if _, err = s.JoinGroup(ctx, b, group.ID, "bob management"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.JoinGroup(ctx, c, other.ID, "carol management"); err != nil {
		t.Fatal(err)
	}
	if err = readMember(t, s, a, b.AccountID); err != nil {
		t.Fatal(err)
	}
	assertCode(t, readMember(t, s, a, c.AccountID), "GROUP_ACCESS_DENIED")
	_, err = s.JoinGroup(ctx, a, other.ID, "alice management")
	assertCode(t, err, "GROUP_ALREADY_JOINED")
	_, err = s.LeaveGroup(ctx, b, "wrong password")
	assertCode(t, err, "INVALID_CREDENTIALS")
	if _, err = s.LeaveGroup(ctx, b, "bob management"); err != nil {
		t.Fatal(err)
	}
	assertCode(t, readMember(t, s, a, b.AccountID), "GROUP_ACCESS_DENIED")
	forged := a
	forged.AccountID = b.AccountID
	_, err = s.Session(ctx, forged)
	assertCode(t, err, "SESSION_REQUIRED")
	state, err = s.Groups(ctx, a)
	if err != nil || len(state.Groups) != 2 || len(state.Members) != 1 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}

// TestAccountPasswordResetAndFailuresStayIndependent protects the other users' sessions and failure budgets.
func TestAccountPasswordResetAndFailuresStayIndependent(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	s.hash = func(value string) (string, error) { return value, nil }
	s.verify = func(hash, password string) bool { return hash == password }
	tokenA, a := groupAccount(t, s, "alice")
	tokenB, b := groupAccount(t, s, "bob")
	for range 10 {
		_, _, _ = s.Login(ctx, "alice", "wrong password")
	}
	_, _, err := s.Login(ctx, "alice", "login password")
	assertCode(t, err, "TOO_MANY_ATTEMPTS")
	if _, _, err = s.Login(ctx, "bob", "login password"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Unlock(ctx, b, "bob management"); err != nil {
		t.Fatal(err)
	}
	if err = s.ResetPasswordFor(ctx, "alice", "login", "replacement password"); err != nil {
		t.Fatal(err)
	}
	_, err = s.Authenticate(ctx, tokenA)
	assertCode(t, err, "SESSION_REQUIRED")
	if _, err = s.Authenticate(ctx, tokenB); err != nil {
		t.Fatal(err)
	}
	if err = s.ChangePassword(ctx, b, "login", "login password", "bob replacement", "bob replacement"); err != nil {
		t.Fatal(err)
	}
	var balanceCount int
	if err = s.DB.QueryRow("SELECT count(*) FROM wallets WHERE account_id IN (?,?)", a.AccountID, b.AccountID).Scan(&balanceCount); err != nil || balanceCount != 2 {
		t.Fatalf("wallets=%d err=%v", balanceCount, err)
	}
}

// TestGroupChangeRefusesDelayedJoin uses independent database connections to cover a join/leave round trip during password work.
func TestGroupChangeRefusesDelayedJoin(t *testing.T) {
	ctx := context.Background()
	s := setupAccount(t)
	_, p := initializeSession(t, s)
	group, err := s.CreateGroup(ctx, "伙伴")
	if err != nil {
		t.Fatal(err)
	}
	other := secondService(t, s)
	started, release := blockVerification(s)
	result := make(chan error, 1)
	go func() { _, err := s.JoinGroup(ctx, p, group.ID, "manage password"); result <- err }()
	<-started
	if _, err = other.JoinGroup(ctx, p, group.ID, "manage password"); err != nil {
		close(release)
		t.Fatal(err)
	}
	if _, err = other.LeaveGroup(ctx, p, "manage password"); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	assertCode(t, <-result, "GROUP_CHANGED")
	state, err := s.Groups(ctx, p)
	if err != nil || state.CurrentGroup != nil {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}
