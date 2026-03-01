package config

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Write openhive.yaml
	yaml := `
system:
  listen_address: "127.0.0.1:8080"
  data_dir: "` + dir + `"
  log_level: "info"
assistant:
  name: "Test Assistant"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "sonnet"
  max_turns: 50
  timeout_minutes: 10
channels:
  discord:
    enabled: false
  whatsapp:
    enabled: false
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "openhive.yaml"), []byte(yaml), 0644))

	// Write providers.yaml
	providersYAML := `
providers:
  default:
    type: oauth
    oauth_token_env: CLAUDE_OAUTH_TOKEN
    models:
      haiku: claude-3-haiku-20240307
      sonnet: claude-3-5-sonnet-20241022
      opus: claude-3-opus-20240229
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "providers.yaml"), []byte(providersYAML), 0644))

	return dir
}

func TestLoader_LoadMaster(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	cfg, err := loader.LoadMaster()
	require.NoError(t, err)

	assert.Equal(t, "127.0.0.1:8080", cfg.System.ListenAddress)
	assert.Equal(t, "Test Assistant", cfg.Assistant.Name)

	// GetMaster should return the same config
	got := loader.GetMaster()
	assert.Equal(t, cfg.System.ListenAddress, got.System.ListenAddress)
}

func TestLoader_SaveMaster(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	cfg := DefaultMasterConfig()
	cfg.System.DataDir = dir
	cfg.Assistant.Name = "Saved Assistant"

	err = loader.SaveMaster(cfg)
	require.NoError(t, err)

	// Reload and verify
	loaded, err := loader.LoadMaster()
	require.NoError(t, err)
	assert.Equal(t, "Saved Assistant", loaded.Assistant.Name)
}

func TestLoader_SaveMaster_InvalidConfig(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	cfg := DefaultMasterConfig()
	cfg.System.ListenAddress = "" // invalid
	err = loader.SaveMaster(cfg)
	assert.Error(t, err)
}

func TestLoader_LoadProviders(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	providers, err := loader.LoadProviders()
	require.NoError(t, err)

	assert.Contains(t, providers, "default")
	assert.Equal(t, "oauth", providers["default"].Type)
}

func TestLoader_SaveProviders(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	providers := map[string]domain.Provider{
		"test": {
			Name:          "test",
			Type:          "oauth",
			OAuthTokenEnv: "TEST_TOKEN",
		},
	}

	err = loader.SaveProviders(providers)
	require.NoError(t, err)

	loaded, err := loader.LoadProviders()
	require.NoError(t, err)
	assert.Contains(t, loaded, "test")
}

func TestLoader_CreateTeamDir(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	err = loader.CreateTeamDir("my-team")
	require.NoError(t, err)

	// Verify directory structure
	teamDir := filepath.Join(dir, "teams", "my-team")
	assert.DirExists(t, teamDir)
	assert.DirExists(t, filepath.Join(teamDir, "agents"))
	assert.DirExists(t, filepath.Join(teamDir, "skills"))
	assert.FileExists(t, filepath.Join(teamDir, "team.yaml"))
	assert.FileExists(t, filepath.Join(teamDir, "CLAUDE.md"))
}

func TestLoader_ListTeams(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	// No teams initially
	teams, err := loader.ListTeams()
	require.NoError(t, err)
	assert.Empty(t, teams)

	// Create teams
	require.NoError(t, loader.CreateTeamDir("team-a"))
	require.NoError(t, loader.CreateTeamDir("team-b"))

	teams, err = loader.ListTeams()
	require.NoError(t, err)
	assert.Len(t, teams, 2)
	assert.Contains(t, teams, "team-a")
	assert.Contains(t, teams, "team-b")
}

func TestLoader_DeleteTeamDir(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	require.NoError(t, loader.CreateTeamDir("to-delete"))
	require.NoError(t, loader.DeleteTeamDir("to-delete"))

	teams, err := loader.ListTeams()
	require.NoError(t, err)
	assert.Empty(t, teams)
}

func TestLoader_LoadTeam(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	require.NoError(t, loader.CreateTeamDir("my-team"))

	team, err := loader.LoadTeam("my-team")
	require.NoError(t, err)
	assert.Equal(t, "my-team", team.Slug)
}

func TestLoader_SaveTeam(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	require.NoError(t, loader.CreateTeamDir("my-team"))

	team := &domain.Team{
		Slug:      "my-team",
		LeaderAID: "aid-lead-001",
	}
	require.NoError(t, loader.SaveTeam("my-team", team))

	loaded, err := loader.LoadTeam("my-team")
	require.NoError(t, err)
	assert.Equal(t, "aid-lead-001", loaded.LeaderAID)
}

func TestLoader_WatchMaster(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)
	defer loader.StopWatching()

	var callCount atomic.Int32
	err = loader.WatchMaster(func(cfg *domain.MasterConfig) {
		callCount.Add(1)
	})
	require.NoError(t, err)

	time.Sleep(20 * time.Millisecond)

	// Modify the config file
	newYAML := `
system:
  listen_address: "0.0.0.0:9090"
  data_dir: "` + dir + `"
  log_level: "debug"
assistant:
  name: "Updated"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "sonnet"
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "openhive.yaml"), []byte(newYAML), 0644))

	time.Sleep(500 * time.Millisecond)
	assert.GreaterOrEqual(t, callCount.Load(), int32(1))
}

func TestLoader_ConcurrentReads(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir)
	require.NoError(t, err)

	_, err = loader.LoadMaster()
	require.NoError(t, err)

	// Concurrent reads should not race
	done := make(chan struct{})
	for i := 0; i < 10; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			cfg := loader.GetMaster()
			assert.NotNil(t, cfg)
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestLoader_StopWatching_NilWatcher(t *testing.T) {
	loader, err := NewLoader(t.TempDir())
	require.NoError(t, err)
	// Should not panic
	loader.StopWatching()
}
