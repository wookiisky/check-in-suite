package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
)

// TestLocalHTTPSProxy verifies Host preservation and secure cookies through an actual loopback proxy.
func TestLocalHTTPSProxy(t *testing.T) {
	app := accountApplication(t)
	backend := httptest.NewServer(app)
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) { director(r); r.Header.Set("X-Forwarded-Proto", "https") }
	frontend := httptest.NewTLSServer(proxy)
	defer frontend.Close()
	request, err := http.NewRequest("POST", frontend.URL+"/api/v1/auth/login", strings.NewReader(`{"username":"family","password":"login-password"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", frontend.URL)
	request.Header.Set("Content-Type", "application/json")
	response, err := frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("proxy login=%d %s", response.StatusCode, body)
	}
	cookies := response.Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Fatalf("proxy cookies=%+v", cookies)
	}
}
