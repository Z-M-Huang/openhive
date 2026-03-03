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

// --- Path Traversal Validation Tests (F1) ---

func TestValidateTeamPath_ValidSlug(t *testing.T) {
	dir := t.TempDir()
	path, err := ValidateTeamPath(dir, "my-team")
	require.NoError(t, err)
	assert.Contains(t, path, "teams")
	assert.Contains(t, path, "my-team")
}

func TestValidateTeamPath_InvalidSlug(t *testing.T) {
	dir := t.TempDir()
	_, err := ValidateTeamPath(dir, "INVALID")
	assert.Error(t, err)
}

func TestValidateTeamPath_EmptySlug(t *testing.T) {
	dir := t.TempDir()
	_, err := ValidateTeamPath(dir, "")
	assert.Error(t, err)
}

func TestValidateTeamPath_PathTraversalDotDot(t *testing.T) {
	// The slug pattern (lowercase letters, numbers, hyphens) rejects ".."
	// but this test explicitly documents the defense.
	dir := t.TempDir()
	_, err := ValidateTeamPath(dir, "../etc/passwd")
	assert.Error(t, err)
}

func TestValidateTeamPath_PathTraversalWithSlashes(t *testing.T) {
	dir := t.TempDir()
	_, err := ValidateTeamPath(dir, "team/../../etc")
	assert.Error(t, err)
}

func TestValidateTeamPath_Symlink(t *testing.T) {
	dir := t.TempDir()

	// Create a symlink in the teams directory
	teamsDir := filepath.Join(dir, "teams")
	require.NoError(t, os.MkdirAll(teamsDir, 0755))

	// Create a target directory
	targetDir := filepath.Join(dir, "secret")
	require.NoError(t, os.MkdirAll(targetDir, 0755))

	// Create symlink: teams/evil -> ../secret
	symlinkPath := filepath.Join(teamsDir, "evil")
	require.NoError(t, os.Symlink(targetDir, symlinkPath))

	_, err := ValidateTeamPath(dir, "evil")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "symlink")
}

func TestValidateTeamPath_TeamsBaseDirSymlink(t *testing.T) {
	dir := t.TempDir()

	// Create a real target directory
	targetDir := filepath.Join(dir, "real-teams")
	require.NoError(t, os.MkdirAll(targetDir, 0755))

	// Make the "teams" directory a symlink pointing to the real directory
	teamsDir := filepath.Join(dir, "teams")
	require.NoError(t, os.Symlink(targetDir, teamsDir))

	_, err := ValidateTeamPath(dir, "my-team")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "teams directory is a symlink")
}

func TestValidateTeamPath_NonexistentIsOK(t *testing.T) {
	// A team path that doesn't exist yet should be allowed (for creation).
	dir := t.TempDir()
	path, err := ValidateTeamPath(dir, "new-team")
	require.NoError(t, err)
	assert.NotEmpty(t, path)
}

func TestCreateTeamDirectory_PathTraversal(t *testing.T) {
	dir := t.TempDir()
	// These are all rejected by slug validation, confirming defense-in-depth
	err := CreateTeamDirectory(dir, "../escape")
	assert.Error(t, err)

	err = CreateTeamDirectory(dir, "team/../..")
	assert.Error(t, err)
}

func TestLoaderDeleteTeamDir_PathTraversal(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir, dir)
	require.NoError(t, err)

	// Attempt to delete with an invalid slug
	err = loader.DeleteTeamDir("../escape")
	assert.Error(t, err)

	err = loader.DeleteTeamDir("")
	assert.Error(t, err)
}

func TestLoaderLoadTeam_PathTraversal(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir, dir)
	require.NoError(t, err)

	_, err = loader.LoadTeam("../escape")
	assert.Error(t, err)
}

func TestLoaderSaveTeam_PathTraversal(t *testing.T) {
	dir := setupTestDataDir(t)
	loader, err := NewLoader(dir, dir)
	require.NoError(t, err)

	team := &domain.Team{Slug: "test"}
	err = loader.SaveTeam("../escape", team)
	assert.Error(t, err)
}
