package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/assets"
)

// TestControlledAssetsHTTP checks authentication and real SVG bytes through the public routes.
func TestControlledAssetsHTTP(t *testing.T) {
	app := accountApplication(t)
	service := assets.New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	app.RegisterAssets(service)
	for _, path := range []string{"/api/v1/assets", "/api/v1/assets/fox-v1"} {
		response := apiRequest(app, "GET", path, "", nil, "")
		if response.Code != 401 {
			t.Fatalf("private asset exposed at %s: %d", path, response.Code)
		}
	}
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	response := apiRequest(app, "GET", "/api/v1/assets", "", cookie, "")
	if response.Code != 200 {
		t.Fatalf("catalog: %d %s", response.Code, response.Body)
	}
	var catalog struct {
		Items []assets.Asset `json:"items"`
	} // Serialized public catalog.
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil || len(catalog.Items) == 0 {
		t.Fatalf("catalog: %v %s", err, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/assets/fox-v1", "", cookie, "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/svg+xml" || !strings.Contains(response.Body.String(), "<svg") {
		t.Fatalf("SVG: %d %s", response.Code, response.Body)
	}
	if response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("asset headers: %v", response.Header())
	}
	response = apiRequest(app, "GET", "/api/v1/assets/missing-v1", "", cookie, "")
	if response.Code != 404 {
		t.Fatalf("missing resource: %d", response.Code)
	}
	response = apiRequest(app, "POST", "/api/v1/auth/logout", "", cookie, jsonCSRF(t, login.Body.Bytes()))
	if response.Code != 204 {
		t.Fatalf("logout: %d", response.Code)
	}
	response = apiRequest(app, "GET", "/api/v1/assets/fox-v1", "", cookie, "")
	if response.Code != 401 {
		t.Fatalf("revoked session read asset: %d", response.Code)
	}
}

// TestOutfitAssetVariantsHTTP verifies real effect variants and persisted PNG/WebP MIME responses.
func TestOutfitAssetVariantsHTTP(t *testing.T) {
	app := accountApplication(t)
	service := assets.New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	app.RegisterAssets(service)
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	for _, key := range []string{"effect-snow-v1", "effect-sparkle-v1"} {
		animated := apiRequest(app, "GET", "/api/v1/assets/"+key, "", cookie, "")
		still := apiRequest(app, "GET", "/api/v1/assets/"+key+"?motion=static", "", cookie, "")
		if animated.Code != 200 || still.Code != 200 || still.Header().Get("Content-Type") != "image/svg+xml" {
			t.Fatalf("effect variants: %d %d %v", animated.Code, still.Code, still.Header())
		}
		if bytes.Equal(animated.Body.Bytes(), still.Body.Bytes()) || bytes.Contains(still.Body.Bytes(), []byte("@keyframes")) {
			t.Fatal("reduced motion did not return the immutable still variant")
		}
		private := apiRequest(app, "GET", "/api/v1/assets/"+key+"?motion=static", "", nil, "")
		if private.Code != 401 {
			t.Fatalf("still variant is not private: %d", private.Code)
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	webp, err := os.ReadFile("../assets/testdata/transparent.webp")
	if err != nil {
		t.Fatal(err)
	}
	for format, body := range map[string][]byte{"png": encoded.Bytes(), "webp": webp} {
		item := assets.Asset{Key: "historical-" + format + "-v1", Name: "历史透明图片", Kind: assets.KindAccessory, Format: format}
		item.URL = "/api/v1/assets/" + item.Key
		path := filepath.Join(service.Directory, item.Key)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		metadata, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "metadata.json"), metadata, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "asset."+format), body, 0600); err != nil {
			t.Fatal(err)
		}
		response := apiRequest(app, "GET", item.URL+"?motion=static", "", cookie, "")
		if response.Code != 200 || response.Header().Get("Content-Type") != "image/"+format || !bytes.Equal(response.Body.Bytes(), body) {
			t.Fatalf("raster response: %d %v", response.Code, response.Header())
		}
		if response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("private raster headers: %v", response.Header())
		}
	}
}

// jsonCSRF extracts the actual session token from a serialized login response.
func jsonCSRF(t *testing.T, data []byte) string {
	t.Helper()
	var session struct {
		Token string `json:"csrf_token"`
	} // CSRF value bound to the real HTTP session.
	if err := json.Unmarshal(data, &session); err != nil {
		t.Fatal(err)
	}
	return session.Token
}
