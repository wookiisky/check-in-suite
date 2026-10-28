package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/media"
)

// TestMediaMultipartHTTP verifies field order, actual bytes, framing limits and immediate cancellation.
func TestMediaMultipartHTTP(t *testing.T) {
	app, service, cookie, csrf := mediaApplication(t)
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	body, contentType := multipartFixture(t, "photo", picture.Bytes(), true)
	response := mediaHTTPRequest(app, body, contentType, cookie, csrf)
	if response.Code != 201 {
		t.Fatalf("upload: %d %s", response.Code, response.Body)
	}
	var uploaded media.Media
	if err := json.Unmarshal(response.Body.Bytes(), &uploaded); err != nil || uploaded.MIMEType != "image/png" {
		t.Fatalf("%+v %v", uploaded, err)
	}
	response = apiRequest(app, "GET", "/api/v1/media/"+uploaded.ID, "", nil, "")
	if response.Code != 401 {
		t.Fatal(response.Code)
	}
	response = apiRequest(app, "GET", "/api/v1/media/"+uploaded.ID, "", cookie, "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%d %v", response.Code, response.Header())
	}
	response = apiRequest(app, "DELETE", "/api/v1/media/"+uploaded.ID, "", cookie, csrf)
	if response.Code != 204 {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	response = apiRequest(app, "GET", "/api/v1/media/"+uploaded.ID, "", cookie, "")
	if response.Code != 404 {
		t.Fatalf("cancelled media readable: %d", response.Code)
	}
	service.Config.Limits.PhotoBytesMax = 100
	service.Config.Limits.AudioBytesMax = 100
	body, contentType = multipartFixture(t, "photo", make([]byte, 101), false)
	response = mediaHTTPRequest(app, body, contentType, cookie, csrf)
	if response.Code != 413 {
		t.Fatalf("file limit: %d %s", response.Code, response.Body)
	}
	body, contentType = multipartFixture(t, "photo", picture.Bytes(), false)
	body = append(body, bytes.Repeat([]byte("x"), 70<<10)...)
	response = mediaHTTPRequest(app, body, contentType, cookie, csrf)
	if response.Code != 413 {
		t.Fatalf("whole multipart limit: %d %s", response.Code, response.Body)
	}
	body, contentType = multipartFixture(t, "photo", []byte("not JPEG bytes"), false)
	response = mediaHTTPRequest(app, body, contentType, cookie, csrf)
	if response.Code != 422 {
		t.Fatalf("fake image: %d %s", response.Code, response.Body)
	}
}

// TestAudioRangeHTTP checks actual persisted recording bytes and native HTTP range semantics.
func TestAudioRangeHTTP(t *testing.T) {
	app, _, cookie, csrf := mediaApplication(t)
	path := filepath.Join(t.TempDir(), "recording.webm")
	command := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.2", "-c:a", "libopus", path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, output)
	}
	audio, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body, contentType := multipartFixture(t, "audio", audio, false)
	response := mediaHTTPRequest(app, body, contentType, cookie, csrf)
	if response.Code != 201 {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	var uploaded media.Media
	if err := json.Unmarshal(response.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/api/v1/media/"+uploaded.ID, nil)
	req.AddCookie(cookie)
	req.Header.Set("Range", "bytes=0-15")
	response = httptest.NewRecorder()
	app.ServeHTTP(response, req)
	if response.Code != 206 || !bytes.Equal(response.Body.Bytes(), audio[:16]) || response.Header().Get("Content-Type") != "audio/webm" || !strings.HasPrefix(response.Header().Get("Content-Range"), "bytes 0-15/") {
		t.Fatalf("range: %d %v", response.Code, response.Header())
	}
}

// mediaApplication uses the real session service with isolated media paths and a real probe binary.
func mediaApplication(t *testing.T) (*App, *media.Service, *http.Cookie, string) {
	t.Helper()
	app := accountApplication(t)
	cfg := app.Config
	dir := t.TempDir()
	cfg.MediaDirectory = filepath.Join(dir, "media")
	cfg.TempDirectory = filepath.Join(dir, "tmp")
	cfg.FFprobePath = "ffprobe"
	cfg.MediaProbeTimeout = 3 * time.Second
	service := media.New(app.DB, app.Accounts, cfg)
	app.RegisterMedia(service)
	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	if login.Code != 200 {
		t.Fatalf("%d %s", login.Code, login.Body)
	}
	return app, service, login.Result().Cookies()[0], jsonCSRF(t, login.Body.Bytes())
}

// multipartFixture serializes actual framing and allows the file to precede its kind.
func multipartFixture(t *testing.T, kind string, file []byte, fileFirst bool) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if !fileFirst {
		if err := writer.WriteField("kind", kind); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", "untrusted-name.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(file); err != nil {
		t.Fatal(err)
	}
	if fileFirst {
		if err := writer.WriteField("kind", kind); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

// mediaHTTPRequest omits Content-Length to exercise streamed limits independently of headers.
func mediaHTTPRequest(app *App, body []byte, contentType string, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/v1/media", bytes.NewReader(body))
	req.ContentLength = -1
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Origin", app.Config.PublicOrigin)
	req.Header.Set("X-CSRF-Token", csrf)
	req.AddCookie(cookie)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, req)
	return response
}
