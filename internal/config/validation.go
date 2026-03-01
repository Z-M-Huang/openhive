package config

import (
	"github.com/Z-M-Huang/openhive/internal/domain"
)

// ValidateMasterConfig validates a MasterConfig struct.
func ValidateMasterConfig(cfg *domain.MasterConfig) error {
	if cfg.System.ListenAddress == "" {
		return &domain.ValidationError{Field: "system.listen_address", Message: "cannot be empty"}
	}
	if cfg.System.DataDir == "" {
		return &domain.ValidationError{Field: "system.data_dir", Message: "cannot be empty"}
	}
	if cfg.System.LogLevel != "" {
		if _, err := domain.ParseLogLevel(cfg.System.LogLevel); err != nil {
			return &domain.ValidationError{Field: "system.log_level", Message: "invalid log level: " + cfg.System.LogLevel}
		}
	}
	if cfg.Assistant.Name == "" {
		return &domain.ValidationError{Field: "assistant.name", Message: "cannot be empty"}
	}
	if cfg.Assistant.AID != "" {
		if err := domain.ValidateAID(cfg.Assistant.AID); err != nil {
			return err
		}
	}
	if cfg.Assistant.Provider == "" {
		return &domain.ValidationError{Field: "assistant.provider", Message: "cannot be empty"}
	}
	if cfg.Assistant.ModelTier != "" {
		if _, err := domain.ParseModelTier(cfg.Assistant.ModelTier); err != nil {
			return &domain.ValidationError{Field: "assistant.model_tier", Message: "invalid model tier: " + cfg.Assistant.ModelTier}
		}
	}
	for i, agent := range cfg.Agents {
		if err := domain.ValidateAgent(&agent); err != nil {
			return &domain.ValidationError{
				Field:   "agents[" + itoa(i) + "]",
				Message: err.Error(),
			}
		}
	}
	return nil
}

func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return itoa(i/10) + string(rune('0'+i%10))
}
