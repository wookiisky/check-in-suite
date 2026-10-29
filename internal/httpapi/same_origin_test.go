package httpapi

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAutomaticOriginGuard uses request metadata rather than a configured site address.
func TestAutomaticOriginGuard(t *testing.T) {
	app := &App{}
	for _, tc := range []struct {
		name    string // Scenario under test.
		target  string // Actual browser destination.
		origin  string // Browser-supplied source when fetch metadata is absent.
		site    string // Fetch metadata from modern browsers.
		allowed bool   // Expected request decision.
	}{
		{"IPv4", "http://192.0.2.5:38100/write", "http://192.0.2.5:38100", "", true},
		{"domain", "https://family.example/write", "https://family.example", "", true},
		{"IPv6", "http://[2001:db8::1]:39100/write", "http://[2001:db8::1]:39100", "", true},
		{"development proxy", "http://127.0.0.1:5173/write", "http://127.0.0.1:5173", "", true},
		{"cross domain", "https://family.example/write", "https://attacker.example", "", false},
		{"cross port", "http://192.0.2.5:38100/write", "http://192.0.2.5:38101", "", false},
		{"opaque origin", "https://family.example/write", "null", "", false},
		{"fetch cross site", "https://family.example/write", "https://family.example", "cross-site", false},
		{"fetch same site", "https://family.example/write", "https://neighbor.family.example", "same-site", false},
		{"fetch same origin", "https://family.example/write", "", "same-origin", true},
		{"non browser", "http://localhost:38100/write", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", tc.target, nil)
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			if tc.site != "" {
				request.Header.Set("Sec-Fetch-Site", tc.site)
			}
			request.Header.Set("X-Forwarded-Host", "attacker.example")
			err := app.originGuard(request)
			if (err == nil) != tc.allowed {
				t.Fatalf("origin decision=%v allowed=%v", err, tc.allowed)
			}
		})
	}
}

// TestAutomaticCookieTransport proves real login cookies follow TLS or a loopback proxy only.
func TestAutomaticCookieTransport(t *testing.T) {
	app := accountApplication(t)
	for _, tc := range []struct {
		name      string // Connection boundary.
		remote    string // Direct TCP peer, independent of HTTP headers.
		tls       bool   // Whether Go accepted a TLS connection.
		forwarded string // Claimed external transport.
		secure    bool   // Required Set-Cookie Secure attribute.
	}{
		{"HTTP", "192.0.2.8:50000", false, "", false},
		{"TLS", "192.0.2.8:50000", true, "", true},
		{"local Caddy", "127.0.0.1:50000", false, "https", true},
		{"IPv6 Caddy", "[::1]:50000", false, "https", true},
		{"external forged proxy", "192.0.2.8:50000", false, "https", false},
		{"missing peer", "", false, "https", false},
		{"forwarded chain", "127.0.0.1:50000", false, "https, http", false},
		{"local HTTP", "127.0.0.1:50000", false, "http", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "http://192.0.2.5:38100/api/v1/auth/login", strings.NewReader(`{"username":"family","password":"login-password"}`))
			request.RemoteAddr = tc.remote
			if tc.tls {
				request.TLS = &tls.ConnectionState{}
			}
			request.Header.Set("Origin", "http://192.0.2.5:38100")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Forwarded-Proto", tc.forwarded)
			response := httptest.NewRecorder()
			app.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("login=%d %s", response.Code, response.Body)
			}
			cookies := response.Result().Cookies()
			if len(cookies) != 1 || cookies[0].Secure != tc.secure {
				t.Fatalf("cookies=%+v secure=%v", cookies, tc.secure)
			}
		})
	}
}
