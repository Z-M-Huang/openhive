package orchestrator

import (
	"encoding/json"
	"log/slog"
	"os"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestLogger(t *testing.T) *slog.Logger {
	t.Helper()
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
}

// --- Helpers ---

// newTeamToolsTestDeps creates a TeamToolsDeps with a real OrgChart and mock ConfigLoader
// backed by in-memory state. Use baseConfig to seed initial master config agents and teams.
func newTeamToolsTestDeps(t *testing.T, masterAgents []domain.Agent, teams map[string]*domain.Team) (TeamToolsDeps, *mockTeamConfigLoader) {
	t.Helper()
	orgChart := config.NewOrgChart()

	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:  "aid-asst-main0001",
			Name: "Assistant",
		},
		Agents: masterAgents,
	}

	teamsForConfig := make(map[string]*domain.Team, len(teams))
	for k, v := range teams {
		teamsForConfig[k] = v
	}

	if err := orgChart.RebuildFromConfig(master, teamsForConfig); err != nil {
		t.Fatalf("failed to build initial orgchart: %v", err)
	}

	loader := newMockTeamConfigLoader(master, teamsForConfig)

	deps := TeamToolsDeps{
		ConfigLoader: loader,
		OrgChart:     orgChart,
		EventBus:     nil,
		Logger:       newTestLogger(t),
	}
	return deps, loader
}

// mockTeamConfigLoader is an in-memory implementation of domain.ConfigLoader for testing.
type mockTeamConfigLoader struct {
	master    *domain.MasterConfig
	teams     map[string]*domain.Team
	deletedDirs []string
}

func newMockTeamConfigLoader(master *domain.MasterConfig, teams map[string]*domain.Team) *mockTeamConfigLoader {
	if teams == nil {
		teams = make(map[string]*domain.Team)
	}
	return &mockTeamConfigLoader{master: master, teams: teams}
}

func (m *mockTeamConfigLoader) LoadMaster() (*domain.MasterConfig, error) {
	copy := *m.master
	return &copy, nil
}
func (m *mockTeamConfigLoader) SaveMaster(cfg *domain.MasterConfig) error {
	m.master = cfg
	return nil
}
func (m *mockTeamConfigLoader) GetMaster() *domain.MasterConfig { return m.master }
func (m *mockTeamConfigLoader) LoadProviders() (map[string]domain.Provider, error) {
	return nil, nil
}
func (m *mockTeamConfigLoader) SaveProviders(_ map[string]domain.Provider) error { return nil }
func (m *mockTeamConfigLoader) LoadTeam(slug string) (*domain.Team, error) {
	team, ok := m.teams[slug]
	if !ok {
		return nil, &domain.NotFoundError{Resource: "team", ID: slug}
	}
	copy := *team
	return &copy, nil
}
func (m *mockTeamConfigLoader) SaveTeam(slug string, team *domain.Team) error {
	m.teams[slug] = team
	return nil
}
func (m *mockTeamConfigLoader) CreateTeamDir(slug string) error {
	if _, exists := m.teams[slug]; exists {
		return &domain.ConflictError{Resource: "team", Message: slug + " already exists"}
	}
	m.teams[slug] = &domain.Team{Slug: slug}
	return nil
}
func (m *mockTeamConfigLoader) DeleteTeamDir(slug string) error {
	if _, ok := m.teams[slug]; !ok {
		return &domain.NotFoundError{Resource: "team", ID: slug}
	}
	delete(m.teams, slug)
	m.deletedDirs = append(m.deletedDirs, slug)
	return nil
}
func (m *mockTeamConfigLoader) ListTeams() ([]string, error) {
	slugs := make([]string, 0, len(m.teams))
	for k := range m.teams {
		slugs = append(slugs, k)
	}
	return slugs, nil
}
func (m *mockTeamConfigLoader) WatchMaster(_ func(*domain.MasterConfig)) error { return nil }
func (m *mockTeamConfigLoader) WatchProviders(_ func(map[string]domain.Provider)) error {
	return nil
}
func (m *mockTeamConfigLoader) WatchTeam(_ string, _ func(*domain.Team)) error { return nil }
func (m *mockTeamConfigLoader) StopWatching()                                   {}

// --- Tests ---

func TestCreateAgent_GeneratesAIDAndSavesToMaster(t *testing.T) {
	deps, loader := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"name":      "Research Agent",
		"role_file": "roles/researcher.role.md",
		"team_slug": "master",
	})
	result, err := handler.HandleToolCall("c1", "create_agent", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "created", resp["status"])
	assert.NotEmpty(t, resp["aid"])
	assert.Contains(t, resp["aid"], "aid-")

	// Verify saved in master config
	master, _ := loader.LoadMaster()
	require.Len(t, master.Agents, 1)
	assert.Equal(t, resp["aid"], master.Agents[0].AID)
	assert.Equal(t, "Research Agent", master.Agents[0].Name)
}

func TestCreateAgent_SavesIntoTeamConfig(t *testing.T) {
	existingTeam := &domain.Team{
		TID:       "tid-eng-00000001",
		Slug:      "engineering",
		LeaderAID: "aid-lead-00000001",
	}
	deps, loader := newTeamToolsTestDeps(t, []domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}}, map[string]*domain.Team{
		"engineering": existingTeam,
	})
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"name":      "Dev Agent",
		"role_file": "roles/dev.role.md",
		"team_slug": "engineering",
	})
	result, err := handler.HandleToolCall("c1", "create_agent", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "created", resp["status"])

	team, _ := loader.LoadTeam("engineering")
	require.Len(t, team.Agents, 1)
	assert.Equal(t, resp["aid"], team.Agents[0].AID)
}

func TestCreateAgent_InvalidModelTier(t *testing.T) {
	deps, _ := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"name":       "Agent",
		"role_file":  "r.md",
		"team_slug":  "master",
		"model_tier": "ultra",
	})
	_, err := handler.HandleToolCall("c1", "create_agent", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "model_tier")
}

func TestCreateAgent_MissingName(t *testing.T) {
	deps, _ := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"role_file": "r.md",
		"team_slug": "master",
	})
	_, err := handler.HandleToolCall("c1", "create_agent", args)
	require.Error(t, err)
}

func TestCreateTeam_TwoStep(t *testing.T) {
	// Step 1: create leader agent
	deps, loader := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	createAgentArgs, _ := json.Marshal(map[string]string{
		"name":      "Lead",
		"role_file": "r.md",
		"team_slug": "master",
	})
	agentResult, err := handler.HandleToolCall("c1", "create_agent", createAgentArgs)
	require.NoError(t, err)
	var agentResp map[string]string
	require.NoError(t, json.Unmarshal(agentResult, &agentResp))
	leaderAID := agentResp["aid"]

	// Rebuild orgchart to see the new agent
	rebuildOrgChart(deps)

	// Step 2: create team with that leader
	createTeamArgs, _ := json.Marshal(map[string]string{
		"slug":       "new-team",
		"leader_aid": leaderAID,
	})
	teamResult, err := handler.HandleToolCall("c2", "create_team", createTeamArgs)
	require.NoError(t, err)
	var teamResp map[string]string
	require.NoError(t, json.Unmarshal(teamResult, &teamResp))
	assert.Equal(t, "created", teamResp["status"])
	assert.Equal(t, "new-team", teamResp["slug"])
	assert.Contains(t, teamResp["tid"], "tid-")

	// Verify saved
	team, _ := loader.LoadTeam("new-team")
	assert.Equal(t, leaderAID, team.LeaderAID)
}

func TestCreateTeam_ValidatesSlug(t *testing.T) {
	deps, _ := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"slug":       "../evil",
		"leader_aid": "aid-test-00000001",
	})
	_, err := handler.HandleToolCall("c1", "create_team", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "slug")
}

func TestCreateTeam_RejectsDuplicateSlug(t *testing.T) {
	existingTeam := &domain.Team{Slug: "existing", LeaderAID: "aid-lead-00000001", TID: "tid-existing0001"}
	deps, _ := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"existing": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"slug":       "existing",
		"leader_aid": "aid-lead-00000001",
	})
	_, err := handler.HandleToolCall("c1", "create_team", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestDeleteTeam_CascadesAndPublishesEvent(t *testing.T) {
	existingTeam := &domain.Team{Slug: "to-delete", LeaderAID: "aid-lead-00000001", TID: "tid-todelete0001"}
	deps, loader := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"to-delete": existingTeam},
	)
	var publishedEvents []domain.Event
	mockBus := &mockEventBus{publishFn: func(e domain.Event) { publishedEvents = append(publishedEvents, e) }}
	deps.EventBus = mockBus

	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"slug": "to-delete"})
	result, err := handler.HandleToolCall("c1", "delete_team", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "deleted", resp["status"])

	// Team should be removed
	assert.Contains(t, loader.deletedDirs, "to-delete")

	// Event should be published
	require.Len(t, publishedEvents, 1)
	assert.Equal(t, domain.EventTypeTeamDeleted, publishedEvents[0].Type)
}

func TestDeleteAgent_ChecksTeamLeadConstraint(t *testing.T) {
	// Create a team whose leader is "aid-lead-00000001"
	existingTeam := &domain.Team{
		Slug:      "engineering",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-eng-00000001",
	}
	deps, _ := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"engineering": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"aid":       "aid-lead-00000001",
		"team_slug": "master",
	})
	_, err := handler.HandleToolCall("c1", "delete_agent", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "leads team")
}

func TestDeleteAgent_RemovesFromTeam(t *testing.T) {
	agentToDelete := domain.Agent{AID: "aid-dev-00000001", Name: "Dev"}
	existingTeam := &domain.Team{
		Slug:      "engineering",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-eng-00000001",
		Agents:    []domain.Agent{agentToDelete},
	}
	deps, loader := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"engineering": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"aid":       "aid-dev-00000001",
		"team_slug": "engineering",
	})
	result, err := handler.HandleToolCall("c1", "delete_agent", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "deleted", resp["status"])

	team, _ := loader.LoadTeam("engineering")
	assert.Empty(t, team.Agents)
}

func TestListTeams_ReturnsOrgChart(t *testing.T) {
	existingTeam := &domain.Team{Slug: "eng", LeaderAID: "aid-lead-00000001", TID: "tid-eng-00000001"}
	deps, _ := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"eng": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	result, err := handler.HandleToolCall("c1", "list_teams", json.RawMessage(`{}`))
	require.NoError(t, err)

	var teams map[string]*domain.Team
	require.NoError(t, json.Unmarshal(result, &teams))
	assert.Contains(t, teams, "eng")
}

func TestGetTeam_ReturnsTeamConfig(t *testing.T) {
	existingTeam := &domain.Team{
		Slug:      "myteam",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-myteam000001",
	}
	deps, _ := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"myteam": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"slug": "myteam"})
	result, err := handler.HandleToolCall("c1", "get_team", args)
	require.NoError(t, err)

	var team domain.Team
	require.NoError(t, json.Unmarshal(result, &team))
	assert.Equal(t, "aid-lead-00000001", team.LeaderAID)
}

func TestUpdateTeam_WhitelistsFields(t *testing.T) {
	existingTeam := &domain.Team{
		Slug:      "myteam",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-myteam000001",
	}
	deps, loader := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"myteam": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	// Valid update
	updateArgs := map[string]interface{}{
		"slug":  "myteam",
		"field": "env_vars",
		"value": map[string]string{"FOO": "bar"},
	}
	updateJSON, _ := json.Marshal(updateArgs)
	result, err := handler.HandleToolCall("c1", "update_team", updateJSON)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "updated", resp["status"])

	team, _ := loader.LoadTeam("myteam")
	assert.Equal(t, "bar", team.EnvVars["FOO"])
}

func TestUpdateTeam_RejectsNonWhitelistedField(t *testing.T) {
	existingTeam := &domain.Team{
		Slug:      "myteam",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-myteam000001",
	}
	deps, _ := newTeamToolsTestDeps(t,
		[]domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
		map[string]*domain.Team{"myteam": existingTeam},
	)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	updateArgs := map[string]interface{}{
		"slug":  "myteam",
		"field": "leader_aid",
		"value": "aid-evil-00000001",
	}
	updateJSON, _ := json.Marshal(updateArgs)
	_, err := handler.HandleToolCall("c1", "update_team", updateJSON)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not updatable")
}

func TestToolArgValidation_RejectsPathTraversalInSlug(t *testing.T) {
	deps, _ := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"slug": "../../etc/passwd"})
	_, err := handler.HandleToolCall("c1", "get_team", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "slug")
}

func TestToolArgValidation_RejectsEmptyRequiredFields(t *testing.T) {
	deps, _ := newTeamToolsTestDeps(t, nil, nil)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTeamTools(handler, deps)

	// create_agent with no name
	args, _ := json.Marshal(map[string]string{"role_file": "r.md", "team_slug": "master"})
	_, err := handler.HandleToolCall("c1", "create_agent", args)
	require.Error(t, err)

	// create_team with no slug
	args2, _ := json.Marshal(map[string]string{"leader_aid": "aid-x-0000001"})
	_, err = handler.HandleToolCall("c2", "create_team", args2)
	require.Error(t, err)
}

// Note: mockEventBus is defined in heartbeat_test.go (same package).
