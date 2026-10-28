package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"slices"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// decodeRequiredJSON distinguishes absent fields from explicit zero, false and allowed null values.
// Only the nullable field names declared by the route accept null; business validation remains in services.
func decodeRequiredJSON(w http.ResponseWriter, r *http.Request, destination any, required []string, nullable ...string) error {
	var raw json.RawMessage
	if err := DecodeJSON(w, r, &raw); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return core.Fail(400, "INVALID_REQUEST")
	}
	for _, name := range required {
		if _, exists := fields[name]; !exists {
			return core.Invalid(name, "REQUIRED")
		}
	}
	for name, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) && !slices.Contains(nullable, name) {
			return core.Invalid(name, "INVALID_VALUE")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return core.Fail(400, "INVALID_REQUEST")
	}
	return nil
}
