package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// TestIslandHTTP exercises authenticated layout writes and conflicts through actual JSON.
func TestIslandHTTP(t *testing.T) {
	app, request := shopHTTPRequest(t)
	app.RegisterIsland(island.New(app.DB, app.Accounts.Now))
	if response := apiRequest(app, http.MethodGet, "/api/v1/island", "", nil, ""); response.Code != 401 {
		t.Fatalf("anonymous read: %d", response.Code)
	}
	if response := request("POST", "/api/v1/management/lock", "", ""); response.Code != 204 {
		t.Fatalf("lock: %d %s", response.Code, response.Body)
	}
	response := request("GET", "/api/v1/island", "", "")
	if response.Code != 200 {
		t.Fatalf("read: %d %s", response.Code, response.Body)
	}
	var initial island.State
	if err := json.Unmarshal(response.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if len(initial.Catalog) == 0 || len(initial.Inventory) < 4 || len(initial.Placements) < 3 {
		t.Fatalf("incomplete starter island: %+v", initial)
	}
	body, err := json.Marshal(island.SaveInput{ExpectedVersion: initial.Version, Placements: initial.Placements})
	if err != nil {
		t.Fatal(err)
	}
	response = request("PUT", "/api/v1/island", string(body), "")
	if response.Code != 200 {
		t.Fatalf("save without management: %d %s", response.Code, response.Body)
	}
	var saved island.State
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Version != initial.Version+1 {
		t.Fatalf("version: %d => %d", initial.Version, saved.Version)
	}
	response = request("PUT", "/api/v1/island", string(body), "")
	if response.Code != 409 || !strings.Contains(response.Body.String(), "VERSION_CONFLICT") {
		t.Fatalf("stale save: %d %s", response.Code, response.Body)
	}
	for _, invalid := range []string{
		`{}`, `{"expected_version":1}`, `{"expected_version":1,"placements":null}`,
		`{"expected_version":1,"placements":[null]}`,
		`{"expected_version":1,"placements":[{"id":"base:desk","item_key":"desk","y":0,"rotation":0,"zone":"indoor"}]}`,
		`{"expected_version":1,"placements":[{"id":"base:desk","item_key":"desk","x":null,"y":0,"rotation":0,"zone":"indoor"}]}`,
		`{"expected_version":1,"placements":[{"id":"base:desk","item_key":"desk","x":0,"y":0,"rotation":0,"zone":"indoor","unknown":true}]}`,
	} {
		response = request("PUT", "/api/v1/island", invalid, "")
		if response.Code != 400 && response.Code != 422 {
			t.Fatalf("invalid request accepted: %s => %d %s", invalid, response.Code, response.Body)
		}
	}
	response = request("PUT", "/api/v1/island", fmt.Sprintf(`{"expected_version":%d,"placements":[{"id":"not-owned","item_key":"tree","x":0,"y":0,"rotation":0,"zone":"outdoor"}]}`, saved.Version), "")
	if response.Code != 400 {
		t.Fatalf("unowned placement accepted: %d %s", response.Code, response.Body)
	}
	response = request("GET", "/api/v1/island", "", "")
	var restored island.State
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &restored) != nil || restored.Version != saved.Version || len(restored.Placements) != len(saved.Placements) {
		t.Fatalf("failed write changed layout: %d %s", response.Code, response.Body)
	}
}
