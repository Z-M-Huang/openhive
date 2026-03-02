package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDefaultMasterConfig(t *testing.T) {
	cfg := DefaultMasterConfig()

	assert.Equal(t, "127.0.0.1:8080", cfg.System.ListenAddress)
	assert.Equal(t, "data", cfg.System.DataDir)
	assert.Equal(t, "/openhive/workspace", cfg.System.WorkspaceRoot)
	assert.Equal(t, "info", cfg.System.LogLevel)
	assert.True(t, cfg.System.LogArchive.Enabled)
	assert.Equal(t, 100000, cfg.System.LogArchive.MaxEntries)
	assert.Equal(t, 5, cfg.System.LogArchive.KeepCopies)

	assert.Equal(t, "OpenHive Assistant", cfg.Assistant.Name)
	assert.Equal(t, "aid-main-001", cfg.Assistant.AID)
	assert.Equal(t, "default", cfg.Assistant.Provider)
	assert.Equal(t, "sonnet", cfg.Assistant.ModelTier)
	assert.Equal(t, 50, cfg.Assistant.MaxTurns)
	assert.Equal(t, 10, cfg.Assistant.TimeoutMinutes)

	assert.False(t, cfg.Channels.Discord.Enabled)
	assert.False(t, cfg.Channels.WhatsApp.Enabled)
}
