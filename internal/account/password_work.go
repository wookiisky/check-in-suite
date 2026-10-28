package account

import "context"

// passwordWork serializes hashing and verification, with cancellation before expensive work starts.
func (s *Service) passwordWork(ctx context.Context, kind string, calculate func() error) error {
	select {
	case s.work <- struct{}{}:
		defer func() { <-s.work }()
	case <-ctx.Done():
		return ctx.Err()
	}
	// Cancellation and an available slot may become ready together; never start canceled work.
	if err := ctx.Err(); err != nil {
		return err
	}
	if kind != "" {
		// Earlier failures can exhaust the budget while this request waits for its slot.
		if err := s.checkAttempts(kind); err != nil {
			return err
		}
	}
	// Callers record any failure before returning, and begin write transactions after this returns.
	return calculate()
}
