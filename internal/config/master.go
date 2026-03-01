package config

import (
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gopkg.in/yaml.v3"
)

// LoadMasterFromFile reads and parses openhive.yaml from the given path.
// It applies compiled defaults first, then overrides from the YAML file,
// then environment variable overrides.
func LoadMasterFromFile(path string) (*domain.MasterConfig, error) {
	cfg := DefaultMasterConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config file %s: %w", path, err)
	}

	applyEnvOverrides(cfg)

	if err := ValidateMasterConfig(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

// SaveMasterToFile writes a MasterConfig to the given path atomically.
func SaveMasterToFile(path string, cfg *domain.MasterConfig) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp config file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to rename temp config file: %w", err)
	}

	return nil
}

// applyEnvOverrides applies OPENHIVE_ prefixed environment variable overrides
// to the config struct. Nested fields use underscores as separators.
// e.g., OPENHIVE_SYSTEM_LISTEN_ADDRESS -> System.ListenAddress
func applyEnvOverrides(cfg *domain.MasterConfig) {
	envMap := map[string]*string{
		"OPENHIVE_SYSTEM_LISTEN_ADDRESS": &cfg.System.ListenAddress,
		"OPENHIVE_SYSTEM_DATA_DIR":       &cfg.System.DataDir,
		"OPENHIVE_SYSTEM_LOG_LEVEL":      &cfg.System.LogLevel,
		"OPENHIVE_ASSISTANT_NAME":        &cfg.Assistant.Name,
		"OPENHIVE_ASSISTANT_AID":         &cfg.Assistant.AID,
		"OPENHIVE_ASSISTANT_PROVIDER":    &cfg.Assistant.Provider,
		"OPENHIVE_ASSISTANT_MODEL_TIER":  &cfg.Assistant.ModelTier,
	}

	for envKey, fieldPtr := range envMap {
		if val := os.Getenv(envKey); val != "" {
			*fieldPtr = val
		}
	}
}

// GetConfigSection retrieves a named section from the MasterConfig as a map.
func GetConfigSection(cfg *domain.MasterConfig, section string) (interface{}, error) {
	switch strings.ToLower(section) {
	case "system":
		return cfg.System, nil
	case "assistant":
		return cfg.Assistant, nil
	case "agents":
		return cfg.Agents, nil
	case "channels":
		return cfg.Channels, nil
	default:
		return nil, &domain.NotFoundError{Resource: "config section", ID: section}
	}
}

// UpdateConfigField updates a specific field in the config by dot-separated path.
func UpdateConfigField(cfg *domain.MasterConfig, section, path string, value interface{}) error {
	v := reflect.ValueOf(cfg).Elem()

	sectionField := findFieldByYAMLTag(v, section)
	if !sectionField.IsValid() {
		return &domain.ValidationError{Field: section, Message: "unknown config section"}
	}

	if path == "" {
		return &domain.ValidationError{Field: "path", Message: "cannot be empty"}
	}

	parts := strings.Split(path, ".")
	current := sectionField
	for _, part := range parts {
		if current.Kind() == reflect.Ptr {
			current = current.Elem()
		}
		if current.Kind() != reflect.Struct {
			return &domain.ValidationError{Field: path, Message: "cannot traverse non-struct field"}
		}
		current = findFieldByYAMLTag(current, part)
		if !current.IsValid() {
			return &domain.ValidationError{Field: path, Message: "unknown config field: " + part}
		}
	}

	if !current.CanSet() {
		return &domain.ValidationError{Field: path, Message: "field cannot be set"}
	}

	val := reflect.ValueOf(value)
	if !val.Type().AssignableTo(current.Type()) {
		// Try converting basic types
		if val.Type().ConvertibleTo(current.Type()) {
			val = val.Convert(current.Type())
		} else {
			return &domain.ValidationError{
				Field:   path,
				Message: fmt.Sprintf("type mismatch: expected %s, got %s", current.Type(), val.Type()),
			}
		}
	}

	current.Set(val)
	return nil
}

// findFieldByYAMLTag finds a struct field by its YAML tag name.
func findFieldByYAMLTag(v reflect.Value, tag string) reflect.Value {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		yamlTag := field.Tag.Get("yaml")
		if yamlTag == "" {
			yamlTag = field.Tag.Get("json")
		}
		// Strip options like ",omitempty"
		if idx := strings.Index(yamlTag, ","); idx != -1 {
			yamlTag = yamlTag[:idx]
		}
		if yamlTag == tag {
			return v.Field(i)
		}
	}
	return reflect.Value{}
}
