package account

import (
	"context"
	"sync"
	"sync/atomic"
)

// passwordWorkProbe exposes overlapping password calculations without allocating Argon2 memory.
type passwordWorkProbe struct {
	active  atomic.Int32  // Calculations currently executing.
	peak    atomic.Int32  // Greatest observed overlap.
	calls   atomic.Int32  // Total expensive calculations admitted.
	entered chan string   // Calculation entries observed by the test.
	release chan struct{} // Closed when the test allows calculations to finish.
}

// newPasswordWorkProbe creates a barrier large enough for the concurrent request tests.
func newPasswordWorkProbe() *passwordWorkProbe {
	return &passwordWorkProbe{entered: make(chan string, 100), release: make(chan struct{})}
}

// run records an expensive calculation and holds it at the test-controlled barrier.
func (p *passwordWorkProbe) run(kind string) {
	active := p.active.Add(1)
	defer p.active.Add(-1)
	for peak := p.peak.Load(); active > peak; peak = p.peak.Load() {
		if p.peak.CompareAndSwap(peak, active) {
			break
		}
	}
	p.calls.Add(1)
	p.entered <- kind
	<-p.release
}

// passwordWaitContext signals when an operation observes cancellation while the work slot is held.
type passwordWaitContext struct {
	context.Context               // Actual caller cancellation and deadline.
	waiting         chan struct{} // Closed when the operation reaches its context-aware wait.
	once            sync.Once     // Context consumers may ask for Done more than once.
}

// Done exposes the cancellation channel and lets the test synchronize before cancellation.
func (c *passwordWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}
