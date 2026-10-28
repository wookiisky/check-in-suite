package account

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// TestConcurrentPasswordFailuresBoundsWork checks both overlap and the queued failure budget.
func TestConcurrentPasswordFailuresBoundsWork(t *testing.T) {
	s := setupAccount(t)
	initializeSession(t, s)
	probe := newPasswordWorkProbe()
	s.verify = func(_, _ string) bool { probe.run("verify"); return false }
	const requests = 40
	results := make(chan error, requests)
	var started sync.WaitGroup
	started.Add(requests)
	for range requests {
		go func() {
			started.Done()
			_, _, err := s.Login(context.Background(), "unknown-user", "wrong password")
			results <- err
		}()
	}
	started.Wait()
	<-probe.entered
	// All contenders can reach the verifier while the first calculation remains blocked.
	time.Sleep(50 * time.Millisecond)
	close(probe.release)
	failures, limited := 0, 0
	for range requests {
		var failure *core.Error
		if err := <-results; !errors.As(err, &failure) {
			t.Fatalf("unexpected error: %v", err)
		}
		switch failure.Code {
		case "INVALID_CREDENTIALS":
			failures++
		case "TOO_MANY_ATTEMPTS":
			limited++
		default:
			t.Fatalf("unexpected failure: %s", failure.Code)
		}
	}
	if peak := probe.peak.Load(); peak != 1 {
		t.Errorf("simultaneous password calculations=%d, want 1", peak)
	}
	if calls := probe.calls.Load(); calls != 10 || failures != 10 || limited != requests-10 {
		t.Errorf("calculations=%d invalid=%d limited=%d, want 10,10,30", calls, failures, limited)
	}
}

// TestPasswordEntryPointsShareWorkLimit covers hashes and verifiers through their actual services.
func TestPasswordEntryPointsShareWorkLimit(t *testing.T) {
	for _, test := range []struct {
		name      string                                           // Public password operation competing with management verification.
		run       func(context.Context, *Service, Principal) error // Actual service entry point.
		wantCode  string                                           // Expected domain failure, if any.
		wantCalls int32                                            // Blocker plus calculations performed by the contender.
	}{
		{"login", func(ctx context.Context, s *Service, _ Principal) error {
			_, _, err := s.Login(ctx, "island", "login password")
			return err
		}, "", 2},
		{"management", func(ctx context.Context, s *Service, _ Principal) error {
			_, err := s.VerifyManagement(ctx, "manage password")
			return err
		}, "", 2},
		{"change", func(ctx context.Context, s *Service, p Principal) error {
			return s.ChangePassword(ctx, p, "login", "login password", "replacement password", "replacement password")
		}, "", 3},
		{"initialize", func(ctx context.Context, s *Service, _ Principal) error {
			return s.Initialize(ctx, "island", "名字", "login password", "manage password")
		}, "ACCOUNT_EXISTS", 3},
		{"reset", func(ctx context.Context, s *Service, _ Principal) error {
			return s.ResetPassword(ctx, "login", "replacement password")
		}, "", 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := setupAccount(t)
			_, p := initializeSession(t, s)
			if _, err := s.Unlock(context.Background(), p, "manage password"); err != nil {
				t.Fatal(err)
			}
			probe := newPasswordWorkProbe()
			s.verify = func(_, _ string) bool { probe.run("verify"); return true }
			s.hash = func(_ string) (string, error) { probe.run("hash"); return "test-hash", nil }
			blocker := make(chan error, 1)
			go func() { _, err := s.VerifyManagement(context.Background(), "manage password"); blocker <- err }()
			<-probe.entered
			result := make(chan error, 1)
			go func() { result <- test.run(context.Background(), s, p) }()
			select {
			case kind := <-probe.entered:
				t.Errorf("%s bypassed the running verifier", kind)
			case <-time.After(30 * time.Millisecond):
			}
			close(probe.release)
			if err := <-blocker; err != nil {
				t.Fatal(err)
			}
			err := <-result
			if test.wantCode != "" {
				assertCode(t, err, test.wantCode)
			} else if err != nil {
				t.Fatal(err)
			}
			if probe.peak.Load() != 1 || probe.calls.Load() != test.wantCalls {
				t.Fatalf("peak=%d calls=%d, want 1,%d", probe.peak.Load(), probe.calls.Load(), test.wantCalls)
			}
		})
	}
}

// TestPasswordWorkCancellation skips waiting and already-canceled work without leaking its slot.
func TestPasswordWorkCancellation(t *testing.T) {
	s := setupAccount(t)
	initializeSession(t, s)
	probe := newPasswordWorkProbe()
	s.verify = func(_, _ string) bool { probe.run("verify"); return true }
	s.hash = func(_ string) (string, error) { probe.run("hash"); return "test-hash", nil }
	blocker := make(chan error, 1)
	go func() { _, err := s.VerifyManagement(context.Background(), "manage password"); blocker <- err }()
	<-probe.entered
	ctx, cancel := context.WithCancel(context.Background())
	loginContext := &passwordWaitContext{Context: ctx, waiting: make(chan struct{})}
	resetContext := &passwordWaitContext{Context: ctx, waiting: make(chan struct{})}
	results := make(chan error, 2)
	go func() { _, _, err := s.Login(loginContext, "island", "login password"); results <- err }()
	go func() { results <- s.ResetPassword(resetContext, "login", "replacement password") }()
	// Both requests reached the cancellable wait while the first verifier still owns the slot.
	<-loginContext.waiting
	<-resetContext.waiting
	select {
	case err := <-results:
		t.Errorf("waiting operation returned before cancellation: %v", err)
	default:
	}
	if calls := probe.calls.Load(); calls != 1 {
		t.Errorf("waiting work bypassed the held slot: calls=%d", calls)
	}
	cancel()
	for range 2 {
		select {
		case err := <-results:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("canceled waiter returned %v", err)
			}
		case <-time.After(time.Second):
			t.Error("canceled waiter stayed blocked")
		}
	}
	if calls := probe.calls.Load(); calls != 1 {
		t.Errorf("canceled work reached calculation: calls=%d", calls)
	}
	close(probe.release)
	if err := <-blocker; err != nil {
		t.Fatal(err)
	}
	// A ready slot must not win over an already canceled request and start hashing.
	for range 30 {
		if err := s.ResetPassword(ctx, "login", "replacement password"); !errors.Is(err, context.Canceled) {
			t.Fatalf("already canceled reset returned %v", err)
		}
	}
	if calls := probe.calls.Load(); calls != 1 {
		t.Fatalf("already canceled work reached calculation: calls=%d", calls)
	}
	if _, err := s.VerifyManagement(context.Background(), "manage password"); err != nil {
		t.Fatal(err)
	}
	if probe.calls.Load() != 2 {
		t.Fatal("slot did not recover after cancellation")
	}
	if len(s.attempts) != 0 {
		t.Fatalf("cancellation or success consumed failures: %v", s.attempts)
	}
}

// TestCancellationBetweenPasswordCalculations avoids starting a second hash after cancellation.
func TestCancellationBetweenPasswordCalculations(t *testing.T) {
	for _, kind := range []string{"initialize", "change"} {
		t.Run(kind, func(t *testing.T) {
			s := setupAccount(t)
			_, p := initializeSession(t, s)
			if _, err := s.Unlock(context.Background(), p, "manage password"); err != nil {
				t.Fatal(err)
			}
			probe := newPasswordWorkProbe()
			s.verify = func(_, _ string) bool { probe.run("verify"); return true }
			s.hash = func(_ string) (string, error) { probe.run("hash"); return "test-hash", nil }
			ctx, cancel := context.WithCancel(context.Background())
			result := make(chan error, 1)
			go func() {
				if kind == "initialize" {
					result <- s.Initialize(ctx, "island", "名字", "login password", "manage password")
				} else {
					result <- s.ChangePassword(ctx, p, "login", "login password", "replacement password", "replacement password")
				}
			}()
			<-probe.entered
			cancel()
			close(probe.release)
			if err := <-result; !errors.Is(err, context.Canceled) {
				t.Fatalf("error=%v", err)
			}
			if calls := probe.calls.Load(); calls != 1 {
				t.Fatalf("calculations=%d want=1", calls)
			}
		})
	}
}

// TestPasswordHashFailureReleasesWork preserves subsequent verification after derivation errors.
func TestPasswordHashFailureReleasesWork(t *testing.T) {
	s := setupAccount(t)
	initializeSession(t, s)
	want := errors.New("injected hash failure")
	s.hash = func(_ string) (string, error) { return "", want }
	if err := s.ResetPassword(context.Background(), "login", "replacement password"); !errors.Is(err, want) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.VerifyManagement(ctx, "manage password"); err != nil {
		t.Fatal(err)
	}
}

// TestSuccessfulPasswordWorkDoesNotUseFailureBudget keeps repeated legitimate requests working.
func TestSuccessfulPasswordWorkDoesNotUseFailureBudget(t *testing.T) {
	s := setupAccount(t)
	initializeSession(t, s)
	s.verify = func(_, _ string) bool { return true }
	for range 12 {
		if _, _, err := s.Login(context.Background(), "island", "login password"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.VerifyManagement(context.Background(), "manage password"); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.attempts) != 0 {
		t.Fatalf("successful requests used the failure budget: %v", s.attempts)
	}
}
