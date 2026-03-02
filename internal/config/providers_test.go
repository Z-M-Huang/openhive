package config

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProviderLoadFromFile_Valid(t *testing.T) {
	dir := t.TempDir()
	content := "providers:\n  default:\n    type: oauth\n    oauth_token: test-token-value\n    models:\n      haiku: claude-3-haiku-20240307\n      sonnet: claude-3-5-sonnet-20241022\n      opus: claude-3-opus-20240229\n"
	writeTestYAML(t, dir, "providers.yaml", content)

	providers, err := LoadProvidersFromFile(filepath.Join(dir, "providers.yaml"))
	require.NoError(t, err)
	assert.Len(t, providers, 1)
	assert.Contains(t, providers, "default")
	assert.Equal(t, "oauth", providers["default"].Type)
}

func TestProviderLoadFromFile_MultiplePresets(t *testing.T) {
	dir := t.TempDir()
	content := "providers:\n  default:\n    type: oauth\n    oauth_token: test-token\n  direct:\n    type: anthropic_direct\n    api_key: sk-test-key\n    base_url: https://api.anthropic.com\n    models:\n      sonnet: claude-3-5-sonnet-20241022\n"
	writeTestYAML(t, dir, "providers.yaml", content)

	providers, err := LoadProvidersFromFile(filepath.Join(dir, "providers.yaml"))
	require.NoError(t, err)
	assert.Len(t, providers, 2)
	assert.Equal(t, "anthropic_direct", providers["direct"].Type)
}

func TestProviderLoadFromFile_MissingFile(t *testing.T) {
	_, err := LoadProvidersFromFile("/nonexistent/providers.yaml")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to read providers file")
}

func TestProviderLoadFromFile_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "providers.yaml", "{{{invalid")
	_, err := LoadProvidersFromFile(filepath.Join(dir, "providers.yaml"))
	assert.Error(t, err)
}

func TestProviderLoadFromFile_NoProviders(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "providers.yaml", "providers:")
	_, err := LoadProvidersFromFile(filepath.Join(dir, "providers.yaml"))
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
}

func TestProviderValidation_Empty(t *testing.T) {
	err := ValidateProviders(map[string]domain.Provider{})
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
	assert.Equal(t, "providers", ve.Field)
}

func TestProviderValidation_InvalidType(t *testing.T) {
	providers := map[string]domain.Provider{
		"bad": {Type: "openai"},
	}
	err := ValidateProviders(providers)
	assert.Error(t, err)
}

func TestProviderValidation_OAuthMissingToken(t *testing.T) {
	providers := map[string]domain.Provider{
		"bad": {Type: "oauth"},
	}
	err := ValidateProviders(providers)
	assert.Error(t, err)
}

func TestProviderValidation_DirectMissingCredentials(t *testing.T) {
	providers := map[string]domain.Provider{
		"bad": {Type: "anthropic_direct"},
	}
	err := ValidateProviders(providers)
	assert.Error(t, err)
}

func TestProviderSaveAndReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "providers.yaml")

	providers := map[string]domain.Provider{
		"test": {
			Name:       "test",
			Type:       "oauth",
			OAuthToken: "test-token-value",
			Models:     map[string]string{"haiku": "test-model"},
		},
	}

	err := SaveProvidersToFile(path, providers)
	require.NoError(t, err)

	loaded, err := LoadProvidersFromFile(path)
	require.NoError(t, err)
	assert.Contains(t, loaded, "test")
	assert.Equal(t, "oauth", loaded["test"].Type)
}

func TestProviderResolveEnv_OAuth(t *testing.T) {
	provider := domain.Provider{
		Type:       "oauth",
		OAuthToken: "test-token-value",
		Models: map[string]string{
			"haiku":  "claude-3-haiku-20240307",
			"sonnet": "claude-3-5-sonnet-20241022",
			"opus":   "claude-3-opus-20240229",
		},
	}

	env := ResolveProviderEnv(provider, "sonnet")
	assert.Equal(t, "test-token-value", env["CLAUDE_CODE_OAUTH_TOKEN"])
	assert.Equal(t, "claude-3-haiku-20240307", env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	assert.Equal(t, "claude-3-5-sonnet-20241022", env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
	assert.Equal(t, "claude-3-opus-20240229", env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
}

func TestProviderResolveEnv_Direct(t *testing.T) {
	testVal := "direct-test-value"
	provider := domain.Provider{
		Type:    "anthropic_direct",
		APIKey:  testVal,
		BaseURL: "https://api.anthropic.com",
		Models: map[string]string{
			"sonnet": "claude-3-5-sonnet-20241022",
		},
	}

	env := ResolveProviderEnv(provider, "sonnet")
	assert.Equal(t, testVal, env["ANTHROPIC_API_KEY"])
	assert.Equal(t, "https://api.anthropic.com", env["ANTHROPIC_BASE_URL"])
	assert.Equal(t, "claude-3-5-sonnet-20241022", env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
}

func TestProviderResolveEnv_OAuthEmptyToken(t *testing.T) {
	provider := domain.Provider{
		Type: "oauth",
	}

	env := ResolveProviderEnv(provider, "sonnet")
	_, exists := env["CLAUDE_CODE_OAUTH_TOKEN"]
	assert.False(t, exists)
}

func TestProviderResolveEnv_AllModelTiers(t *testing.T) {
	provider := domain.Provider{
		Type:       "oauth",
		OAuthToken: "test-token",
		Models: map[string]string{
			"haiku":  "haiku-model",
			"sonnet": "sonnet-model",
			"opus":   "opus-model",
		},
	}

	env := ResolveProviderEnv(provider, "haiku")
	assert.Equal(t, "haiku-model", env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	assert.Equal(t, "sonnet-model", env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
	assert.Equal(t, "opus-model", env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
}

func TestProviderResolveEnv_DirectInlineCredential(t *testing.T) {
	// Test that inline credentials in the Provider struct get resolved
	testVal := "inline-test-val"
	provider := domain.Provider{
		Type:   "anthropic_direct",
		APIKey: testVal,
	}
	env := ResolveProviderEnv(provider, "sonnet")
	assert.Equal(t, testVal, env["ANTHROPIC_API_KEY"])
}
