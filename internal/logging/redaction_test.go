package logging

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRedactor_RedactParams_APIKey(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"api_key": "sk-12345", "name": "test"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["api_key"])
	assert.Equal(t, "test", m["name"])
}

func TestRedactor_RedactParams_MasterKey(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"master_key": "my-secret-master-key-value"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["master_key"])
}

func TestRedactor_RedactParams_OAuthToken(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"oauth_token": "bearer-abc123"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["oauth_token"])
}

func TestRedactor_RedactParams_Token(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"token": "jwt-xyz"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["token"])
}

func TestRedactor_RedactParams_Authorization(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"authorization": "Bearer xzy"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["authorization"])
}

func TestRedactor_RedactParams_Secrets(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"secrets": {"GITHUB_TOKEN": "ghp_abc"}}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "[REDACTED]", m["secrets"])
}

func TestRedactor_RedactParams_Nested(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"config": {"provider": {"api_key": "sk-nested"}}, "name": "test"}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	config := m["config"].(map[string]interface{})
	provider := config["provider"].(map[string]interface{})
	assert.Equal(t, "[REDACTED]", provider["api_key"])
	assert.Equal(t, "test", m["name"])
}

func TestRedactor_RedactParams_Array(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`[{"api_key": "sk-1"}, {"api_key": "sk-2"}]`)
	result := r.RedactParams(input)

	var arr []map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &arr))
	assert.Len(t, arr, 2)
	assert.Equal(t, "[REDACTED]", arr[0]["api_key"])
	assert.Equal(t, "[REDACTED]", arr[1]["api_key"])
}

func TestRedactor_RedactParams_Empty(t *testing.T) {
	r := NewRedactor()
	result := r.RedactParams(nil)
	assert.Nil(t, result)
}

func TestRedactor_RedactParams_InvalidJSON(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`not valid json`)
	result := r.RedactParams(input)
	assert.Equal(t, input, result)
}

func TestRedactor_RedactParams_NonSensitiveUntouched(t *testing.T) {
	r := NewRedactor()
	input := json.RawMessage(`{"name": "test", "count": 42, "active": true}`)
	result := r.RedactParams(input)

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &m))
	assert.Equal(t, "test", m["name"])
	assert.Equal(t, float64(42), m["count"])
	assert.Equal(t, true, m["active"])
}

func TestRedactor_RedactString(t *testing.T) {
	r := NewRedactor()
	result := r.RedactString("setting API_KEY=sk-12345 for provider")
	assert.Contains(t, result, "[REDACTED]")
	assert.NotContains(t, result, "sk-12345")
}

func TestRedactor_RedactString_NoMatch(t *testing.T) {
	r := NewRedactor()
	input := "normal log message"
	result := r.RedactString(input)
	assert.Equal(t, input, result)
}

func TestRedactor_RedactString_AtEnd(t *testing.T) {
	r := NewRedactor()
	result := r.RedactString("set TOKEN=abc123")
	assert.Contains(t, result, "[REDACTED]")
	assert.NotContains(t, result, "abc123")
}

func TestRedactor_RedactParams_AllSensitiveFields(t *testing.T) {
	r := NewRedactor()
	fields := []string{"api_key", "master_key", "oauth_token", "token", "authorization", "secrets"}
	for _, field := range fields {
		input := json.RawMessage(`{"` + field + `": "sensitive-value"}`)
		result := r.RedactParams(input)

		var m map[string]interface{}
		require.NoError(t, json.Unmarshal(result, &m))
		assert.Equal(t, "[REDACTED]", m[field], "field %s should be redacted", field)
	}
}
