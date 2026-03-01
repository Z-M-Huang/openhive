package config

import (
	"errors"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
)

func TestValidateMasterConfig_Valid(t *testing.T) {
	cfg := DefaultMasterConfig()
	assert.NoError(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_EmptyListenAddress(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.System.ListenAddress = ""
	err := ValidateMasterConfig(cfg)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
	assert.Equal(t, "system.listen_address", ve.Field)
}

func TestValidateMasterConfig_EmptyDataDir(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.System.DataDir = ""
	err := ValidateMasterConfig(cfg)
	assert.Error(t, err)
}

func TestValidateMasterConfig_InvalidLogLevel(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.System.LogLevel = "invalid"
	err := ValidateMasterConfig(cfg)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
	assert.Contains(t, ve.Message, "invalid log level")
}

func TestValidateMasterConfig_EmptyAssistantName(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Assistant.Name = ""
	assert.Error(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_InvalidAID(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Assistant.AID = "bad-aid"
	assert.Error(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_EmptyProvider(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Assistant.Provider = ""
	assert.Error(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_InvalidModelTier(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Assistant.ModelTier = "mega"
	assert.Error(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_InvalidAgent(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Agents = []domain.Agent{{AID: "", Name: "test"}}
	assert.Error(t, ValidateMasterConfig(cfg))
}

func TestValidateMasterConfig_ValidWithAgents(t *testing.T) {
	cfg := DefaultMasterConfig()
	cfg.Agents = []domain.Agent{{AID: "aid-lead-001", Name: "team-lead"}}
	assert.NoError(t, ValidateMasterConfig(cfg))
}
