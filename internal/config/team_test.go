package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTeamLoadFromFile(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "team.yaml", `
leader_aid: "aid-lead-001"
agents:
  - aid: "aid-agent-001"
    name: "agent-1"
    provider: "default"
    model_tier: "sonnet"
`)

	team, err := LoadTeamFromFile(filepath.Join(dir, "team.yaml"), "my-team")
	require.NoError(t, err)
	assert.Equal(t, "my-team", team.Slug)
	assert.Equal(t, "aid-lead-001", team.LeaderAID)
	assert.Len(t, team.Agents, 1)
}

func TestTeamLoadFromFile_MissingFile(t *testing.T) {
	_, err := LoadTeamFromFile("/nonexistent/team.yaml", "test")
	assert.Error(t, err)
}

func TestTeamLoadFromFile_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	writeTestYAML(t, dir, "team.yaml", "{{{invalid")
	_, err := LoadTeamFromFile(filepath.Join(dir, "team.yaml"), "test")
	assert.Error(t, err)
}

func TestTeamSaveToFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "team.yaml")

	team := &domain.Team{
		Slug:      "my-team",
		LeaderAID: "aid-lead-001",
		Agents: []domain.Agent{
			{AID: "aid-agent-001", Name: "agent-1"},
		},
	}

	err := SaveTeamToFile(path, team)
	require.NoError(t, err)

	loaded, err := LoadTeamFromFile(path, "my-team")
	require.NoError(t, err)
	assert.Equal(t, "aid-lead-001", loaded.LeaderAID)
	assert.Len(t, loaded.Agents, 1)
}

func TestCreateTeamDirectory(t *testing.T) {
	dir := t.TempDir()

	err := CreateTeamDirectory(dir, "my-dev-team")
	require.NoError(t, err)

	teamDir := filepath.Join(dir, "teams", "my-dev-team")
	assert.DirExists(t, teamDir)
	assert.DirExists(t, filepath.Join(teamDir, "agents"))
	assert.DirExists(t, filepath.Join(teamDir, "skills"))
	assert.FileExists(t, filepath.Join(teamDir, "team.yaml"))
	assert.FileExists(t, filepath.Join(teamDir, "CLAUDE.md"))

	// Verify CLAUDE.md contains display name
	claudeContent, err := os.ReadFile(filepath.Join(teamDir, "CLAUDE.md"))
	require.NoError(t, err)
	assert.Contains(t, string(claudeContent), "My Dev Team")
}

func TestCreateTeamDirectory_InvalidSlug(t *testing.T) {
	dir := t.TempDir()
	err := CreateTeamDirectory(dir, "Invalid-Slug")
	assert.Error(t, err)
}

func TestCreateTeamDirectory_Idempotent(t *testing.T) {
	dir := t.TempDir()

	// Create twice
	require.NoError(t, CreateTeamDirectory(dir, "my-team"))
	require.NoError(t, CreateTeamDirectory(dir, "my-team"))
}

func TestSlugValidation_InCreateTeamDirectory(t *testing.T) {
	dir := t.TempDir()

	tests := []struct {
		slug    string
		wantErr bool
	}{
		{"my-team", false},
		{"team123", false},
		{"MY-TEAM", true},
		{"my_team", true},
		{"", true},
	}

	for _, tt := range tests {
		err := CreateTeamDirectory(dir, tt.slug)
		if tt.wantErr {
			assert.Error(t, err, "slug: %s", tt.slug)
		} else {
			assert.NoError(t, err, "slug: %s", tt.slug)
		}
	}
}
