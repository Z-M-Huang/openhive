package config

import (
	"fmt"
	"os"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gopkg.in/yaml.v3"
)

// providersFile is the wrapper struct for providers.yaml
type providersFile struct {
	Providers map[string]domain.Provider `yaml:"providers"`
}

// LoadProvidersFromFile reads and parses providers.yaml.
func LoadProvidersFromFile(path string) (map[string]domain.Provider, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read providers file %s: %w", path, err)
	}

	var pf providersFile
	if err := yaml.Unmarshal(data, &pf); err != nil {
		return nil, fmt.Errorf("failed to parse providers file %s: %w", path, err)
	}

	if pf.Providers == nil {
		pf.Providers = make(map[string]domain.Provider)
	}

	if err := ValidateProviders(pf.Providers); err != nil {
		return nil, err
	}

	return pf.Providers, nil
}

// SaveProvidersToFile writes providers.yaml atomically.
func SaveProvidersToFile(path string, providers map[string]domain.Provider) error {
	pf := providersFile{Providers: providers}
	data, err := yaml.Marshal(&pf)
	if err != nil {
		return fmt.Errorf("failed to marshal providers: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp providers file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to rename temp providers file: %w", err)
	}

	return nil
}

// ValidateProviders validates a map of provider presets.
func ValidateProviders(providers map[string]domain.Provider) error {
	if len(providers) == 0 {
		return &domain.ValidationError{Field: "providers", Message: "at least one provider preset must be defined"}
	}

	for name, p := range providers {
		p.Name = name
		if err := domain.ValidateProvider(&p); err != nil {
			return &domain.ValidationError{Field: "providers." + name, Message: err.Error()}
		}
	}

	return nil
}

// ResolveProviderEnv resolves a provider preset to environment variables
// for a container. Returns a map of env var name -> value.
func ResolveProviderEnv(provider domain.Provider, tier string) map[string]string {
	env := make(map[string]string)

	pt, _ := domain.ParseProviderType(provider.Type)
	switch pt {
	case domain.ProviderTypeOAuth:
		if provider.OAuthTokenEnv != "" {
			if val := os.Getenv(provider.OAuthTokenEnv); val != "" {
				env["CLAUDE_CODE_OAUTH_TOKEN"] = val
			}
		}
	case domain.ProviderTypeAnthropicDirect:
		if provider.APIKeyEnv != "" {
			if val := os.Getenv(provider.APIKeyEnv); val != "" {
				env["ANTHROPIC_API_KEY"] = val
			}
		} else if provider.APIKey != "" {
			env["ANTHROPIC_API_KEY"] = provider.APIKey
		}
		if provider.BaseURL != "" {
			env["ANTHROPIC_BASE_URL"] = provider.BaseURL
		}
	}

	// Model tier env vars
	for t, model := range provider.Models {
		mt, err := domain.ParseModelTier(t)
		if err != nil {
			continue
		}
		switch mt {
		case domain.ModelTierHaiku:
			env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = model
		case domain.ModelTierSonnet:
			env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = model
		case domain.ModelTierOpus:
			env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = model
		}
	}

	return env
}
