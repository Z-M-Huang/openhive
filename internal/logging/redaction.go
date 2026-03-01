package logging

import (
	"encoding/json"
	"strings"
)

// sensitiveFields are JSON keys whose values must be redacted.
var sensitiveFields = map[string]bool{
	"api_key":       true,
	"master_key":    true,
	"oauth_token":   true,
	"token":         true,
	"authorization": true,
	"secrets":       true,
}

// Redactor handles sensitive field redaction in log entries.
type Redactor struct {
	fields map[string]bool
}

// NewRedactor creates a Redactor with the default sensitive fields.
func NewRedactor() *Redactor {
	return &Redactor{fields: sensitiveFields}
}

// RedactParams recursively walks a JSON document and replaces values of
// sensitive keys with "[REDACTED]".
func (r *Redactor) RedactParams(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}

	var obj interface{}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return raw
	}

	redacted := r.redactValue(obj)
	out, err := json.Marshal(redacted)
	if err != nil {
		return raw
	}
	return out
}

func (r *Redactor) redactValue(v interface{}) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		result := make(map[string]interface{}, len(val))
		for k, v := range val {
			if r.fields[strings.ToLower(k)] {
				result[k] = "[REDACTED]"
			} else {
				result[k] = r.redactValue(v)
			}
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(val))
		for i, item := range val {
			result[i] = r.redactValue(item)
		}
		return result
	default:
		return v
	}
}

// RedactString checks if a string contains sensitive patterns and returns
// a safe version. This is a basic implementation that replaces known env var
// patterns.
func (r *Redactor) RedactString(s string) string {
	// Redact known env-var-style patterns like KEY=value
	for field := range r.fields {
		upper := strings.ToUpper(field)
		// Check for FIELD=value pattern
		if idx := strings.Index(s, upper+"="); idx != -1 {
			end := strings.IndexByte(s[idx+len(upper)+1:], ' ')
			if end == -1 {
				s = s[:idx+len(upper)+1] + "[REDACTED]"
			} else {
				s = s[:idx+len(upper)+1] + "[REDACTED]" + s[idx+len(upper)+1+end:]
			}
		}
	}
	return s
}
