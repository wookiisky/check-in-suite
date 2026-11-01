package httpapi

import (
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestLegacyIslandRoutesRetired 保留新版布局与资格端点，旧二维路由明确退出。
func TestLegacyIslandRoutesRetired(t *testing.T) {
	app, request := shopHTTPRequest(t)
	app.RegisterIsland(island.New(app.DB, time.Now))
	for _, method := range []string{"GET", "PUT"} {
		response := request(method, "/api/v1/island", `{}`, "")
		if response.Code != 404 {
			t.Fatalf("legacy %s still registered: %d %s", method, response.Code, response.Body)
		}
	}
	for _, path := range []string{"/api/v1/island/layout", "/api/v1/island/activity-access"} {
		response := request("GET", path, "", "")
		if response.Code != 200 {
			t.Fatalf("new endpoint %s: %d %s", path, response.Code, response.Body)
		}
	}
}
