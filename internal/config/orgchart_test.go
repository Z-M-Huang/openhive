package config

import (
	"errors"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func buildTestOrgChart(t *testing.T) *OrgChartService {
	t.Helper()
	oc := NewOrgChart()

	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:       "aid-main-001",
			Name:      "Main Assistant",
			Provider:  "default",
			ModelTier: "sonnet",
		},
		Agents: []domain.Agent{
			{AID: "aid-lead-001", Name: "team-lead-a"},
		},
	}

	teams := map[string]*domain.Team{
		"team-a": {
			Slug:      "team-a",
			LeaderAID: "aid-lead-001",
			Agents: []domain.Agent{
				{AID: "aid-a1-001", Name: "agent-a1"},
				{AID: "aid-a2-001", Name: "agent-a2"},
			},
		},
	}

	require.NoError(t, oc.RebuildFromConfig(master, teams))
	return oc
}

func TestOrgChart_RebuildFromConfig(t *testing.T) {
	oc := buildTestOrgChart(t)

	chart := oc.GetOrgChart()
	assert.Len(t, chart, 1)
	assert.Contains(t, chart, "team-a")
}

func TestOrgChart_GetAgentByAID(t *testing.T) {
	oc := buildTestOrgChart(t)

	agent, err := oc.GetAgentByAID("aid-main-001")
	require.NoError(t, err)
	assert.Equal(t, "Main Assistant", agent.Name)

	agent, err = oc.GetAgentByAID("aid-a1-001")
	require.NoError(t, err)
	assert.Equal(t, "agent-a1", agent.Name)

	_, err = oc.GetAgentByAID("aid-nonexistent-001")
	assert.Error(t, err)
	var nfe *domain.NotFoundError
	assert.True(t, errors.As(err, &nfe))
}

func TestOrgChart_GetTeamBySlug(t *testing.T) {
	oc := buildTestOrgChart(t)

	team, err := oc.GetTeamBySlug("team-a")
	require.NoError(t, err)
	assert.Equal(t, "aid-lead-001", team.LeaderAID)

	_, err = oc.GetTeamBySlug("nonexistent")
	assert.Error(t, err)
}

func TestOrgChart_GetTeamForAgent(t *testing.T) {
	oc := buildTestOrgChart(t)

	team, err := oc.GetTeamForAgent("aid-a1-001")
	require.NoError(t, err)
	assert.Equal(t, "team-a", team.Slug)

	_, err = oc.GetTeamForAgent("aid-main-001")
	assert.Error(t, err) // Main assistant is not in any team's agent list
}

func TestOrgChart_GetLeadTeams(t *testing.T) {
	oc := buildTestOrgChart(t)

	slugs, err := oc.GetLeadTeams("aid-lead-001")
	require.NoError(t, err)
	assert.Equal(t, []string{"team-a"}, slugs)

	slugs, err = oc.GetLeadTeams("aid-a1-001")
	require.NoError(t, err)
	assert.Nil(t, slugs)
}

func TestOrgChart_GetSubordinates(t *testing.T) {
	oc := buildTestOrgChart(t)

	subs, err := oc.GetSubordinates("aid-lead-001")
	require.NoError(t, err)
	assert.Len(t, subs, 2)
}

func TestOrgChart_GetSupervisor(t *testing.T) {
	oc := buildTestOrgChart(t)

	sup, err := oc.GetSupervisor("aid-a1-001")
	require.NoError(t, err)
	assert.Equal(t, "aid-lead-001", sup.AID)
}

func TestOrgChart_DuplicateAID(t *testing.T) {
	oc := NewOrgChart()

	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:       "aid-main-001",
			Name:      "Main",
			Provider:  "default",
			ModelTier: "sonnet",
		},
	}

	teams := map[string]*domain.Team{
		"team-a": {
			Slug:      "team-a",
			LeaderAID: "aid-lead-001",
			Agents: []domain.Agent{
				{AID: "aid-dup-001", Name: "agent-1"},
			},
		},
		"team-b": {
			Slug:      "team-b",
			LeaderAID: "aid-lead-002",
			Agents: []domain.Agent{
				{AID: "aid-dup-001", Name: "agent-2"}, // duplicate!
			},
		},
	}

	err := oc.RebuildFromConfig(master, teams)
	assert.Error(t, err)
	var ce *domain.ConflictError
	assert.True(t, errors.As(err, &ce))
	assert.Contains(t, ce.Message, "duplicate AID")
}

func TestOrgChart_DuplicateAIDInMaster(t *testing.T) {
	oc := NewOrgChart()

	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:       "aid-main-001",
			Name:      "Main",
			Provider:  "default",
			ModelTier: "sonnet",
		},
		Agents: []domain.Agent{
			{AID: "aid-main-001", Name: "duplicate"}, // same as assistant
		},
	}

	err := oc.RebuildFromConfig(master, nil)
	assert.Error(t, err)
}

func TestOrgChart_CircularParent(t *testing.T) {
	oc := NewOrgChart()

	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:       "aid-main-001",
			Name:      "Main",
			Provider:  "default",
			ModelTier: "sonnet",
		},
	}

	teams := map[string]*domain.Team{
		"team-a": {
			Slug:       "team-a",
			ParentSlug: "team-b",
			LeaderAID:  "aid-lead-001",
		},
		"team-b": {
			Slug:       "team-b",
			ParentSlug: "team-a", // circular!
			LeaderAID:  "aid-lead-002",
		},
	}

	err := oc.RebuildFromConfig(master, teams)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.True(t, errors.As(err, &ve))
	assert.Contains(t, ve.Message, "circular")
}

func TestOrgChart_EmptyRebuild(t *testing.T) {
	oc := NewOrgChart()
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{
			AID:       "aid-main-001",
			Name:      "Main",
			Provider:  "default",
			ModelTier: "sonnet",
		},
	}
	err := oc.RebuildFromConfig(master, nil)
	require.NoError(t, err)

	chart := oc.GetOrgChart()
	assert.Empty(t, chart)
}
