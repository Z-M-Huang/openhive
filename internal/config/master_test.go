package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeTestYAML(t *testing.T, dir, filename, content string) string {
	t.Helper()
	path := filepath.Join(dir, filename)
	require.NoError(t, os.WriteFile(path, []byte(content), 0644))
	return path
}

func TestLoadMasterFromFile_Valid(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "openhive.yaml", `
system:
  listen_address: "0.0.0.0:9090"
  data_dir: "mydata"
  log_level: "debug"
assistant:
  name: "Test Assistant"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "haiku"
  max_turns: 10
  timeout_minutes: 5
channels:
  discord:
    enabled: true
    token: "test-token"
`)

	cfg, err := LoadMasterFromFile(filepath.Join(dir, "openhive.yaml"))
	require.NoError(t, err)

	assert.Equal(t, "0.0.0.0:9090", cfg.System.ListenAddress)
	assert.Equal(t, "mydata", cfg.System.DataDir)
	assert.Equal(t, "debug", cfg.System.LogLevel)
	assert.Equal(t, "Test Assistant", cfg.Assistant.Name)
	assert.Equal(t, "aid-test-001", cfg.Assistant.AID)
	assert.True(t, cfg.Channels.Discord.Enabled)
	assert.Equal(t, "test-token", cfg.Channels.Discord.Token)
}

func TestLoadMasterFromFile_WithDefaults(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "openhive.yaml", `
assistant:
  name: "Test"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "sonnet"
`)

	cfg, err := LoadMasterFromFile(filepath.Join(dir, "openhive.yaml"))
	require.NoError(t, err)

	// Defaults should be applied
	assert.Equal(t, "127.0.0.1:8080", cfg.System.ListenAddress)
	assert.Equal(t, "data", cfg.System.DataDir)
}

func TestLoadMasterFromFile_EnvOverrides(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "openhive.yaml", `
system:
  listen_address: "127.0.0.1:8080"
  data_dir: "data"
assistant:
  name: "Test"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "sonnet"
`)

	t.Setenv("OPENHIVE_SYSTEM_LISTEN_ADDRESS", "0.0.0.0:3000")
	t.Setenv("OPENHIVE_SYSTEM_LOG_LEVEL", "debug")

	cfg, err := LoadMasterFromFile(filepath.Join(dir, "openhive.yaml"))
	require.NoError(t, err)

	assert.Equal(t, "0.0.0.0:3000", cfg.System.ListenAddress)
	assert.Equal(t, "debug", cfg.System.LogLevel)
}

func TestLoadMasterFromFile_MissingFile(t *testing.T) {
	_, err := LoadMasterFromFile("/nonexistent/openhive.yaml")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to read config file")
}

func TestLoadMasterFromFile_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "openhive.yaml", `{{{invalid yaml`)
	_, err := LoadMasterFromFile(filepath.Join(dir, "openhive.yaml"))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to parse config file")
}

func TestLoadMasterFromFile_InvalidConfig(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "openhive.yaml", `
system:
  listen_address: ""
assistant:
  name: "Test"
  aid: "aid-test-001"
  provider: "default"
`)

	_, err := LoadMasterFromFile(filepath.Join(dir, "openhive.yaml"))
	assert.Error(t, err)
}

func TestSaveMasterToFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openhive.yaml")

	cfg := DefaultMasterConfig()
	err := SaveMasterToFile(path, cfg)
	require.NoError(t, err)

	// Reload and verify
	loaded, err := LoadMasterFromFile(path)
	require.NoError(t, err)
	assert.Equal(t, cfg.System.ListenAddress, loaded.System.ListenAddress)
	assert.Equal(t, cfg.Assistant.Name, loaded.Assistant.Name)
}

func TestGetConfigSection(t *testing.T) {
	cfg := DefaultMasterConfig()

	system, err := GetConfigSection(cfg, "system")
	require.NoError(t, err)
	assert.NotNil(t, system)

	assistant, err := GetConfigSection(cfg, "assistant")
	require.NoError(t, err)
	assert.NotNil(t, assistant)

	channels, err := GetConfigSection(cfg, "channels")
	require.NoError(t, err)
	assert.NotNil(t, channels)

	agents, err := GetConfigSection(cfg, "agents")
	require.NoError(t, err)
	assert.Nil(t, agents)

	_, err = GetConfigSection(cfg, "unknown")
	assert.Error(t, err)
}

func TestUpdateConfigField(t *testing.T) {
	cfg := DefaultMasterConfig()

	err := UpdateConfigField(cfg, "system", "listen_address", "0.0.0.0:9090")
	require.NoError(t, err)
	assert.Equal(t, "0.0.0.0:9090", cfg.System.ListenAddress)
}

func TestUpdateConfigField_Nested(t *testing.T) {
	cfg := DefaultMasterConfig()

	err := UpdateConfigField(cfg, "channels", "discord.enabled", true)
	require.NoError(t, err)
	assert.True(t, cfg.Channels.Discord.Enabled)
}

func TestUpdateConfigField_UnknownSection(t *testing.T) {
	cfg := DefaultMasterConfig()
	err := UpdateConfigField(cfg, "unknown", "field", "value")
	assert.Error(t, err)
}

func TestUpdateConfigField_UnknownField(t *testing.T) {
	cfg := DefaultMasterConfig()
	err := UpdateConfigField(cfg, "system", "nonexistent", "value")
	assert.Error(t, err)
}

func TestUpdateConfigField_EmptyPath(t *testing.T) {
	cfg := DefaultMasterConfig()
	err := UpdateConfigField(cfg, "system", "", "value")
	assert.Error(t, err)
}
