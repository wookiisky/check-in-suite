package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestRequestDeadlines separates ordinary requests from the longer media upload budget.
func TestRequestDeadlines(t *testing.T) {
	app := accountApplication(t)
	app.Config.HTTPTimeout = time.Second
	app.Config.UploadTimeout = 30 * time.Second
	for _, path := range []string{"/api/v1/deadline-test", "/api/v1/media"} {
		app.Mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			deadline, ok := r.Context().Deadline()
			if !ok {
				t.Error("request has no deadline")
				return
			}
			remaining := time.Until(deadline)
			if r.URL.Path == "/api/v1/media" {
				if remaining <= app.Config.HTTPTimeout || remaining > app.Config.UploadTimeout {
					t.Errorf("upload deadline: %s", remaining)
				}
			} else if remaining <= 0 || remaining > app.Config.HTTPTimeout {
				t.Errorf("ordinary deadline: %s", remaining)
			}
		})
		app.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, path, nil))
	}
}
