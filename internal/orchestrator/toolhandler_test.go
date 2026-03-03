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

func newTestToolHandler(t *testing.T) *ToolHandler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	return NewToolHandler(logger)
}

func TestToolHandler_HandleToolCall_Success(t *testing.T) {
	h := newTestToolHandler(t)

	h.Register("get_config", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	result, err := h.HandleToolCall("call-001", "get_config", json.RawMessage(`{}`))
	require.NoError(t, err)

	var data map[string]string
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Equal(t, "ok", data["status"])
}

func TestToolHandler_HandleToolCall_UnknownTool(t *testing.T) {
	h := newTestToolHandler(t)

	result, err := h.HandleToolCall("call-002", "unknown_tool", json.RawMessage(`{}`))
	assert.Error(t, err)
	// NotFoundError: "tool not found: unknown_tool"
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
	assert.Equal(t, "tool", nfe.Resource)
	assert.Equal(t, "unknown_tool", nfe.ID)
	assert.Nil(t, result)
}

func TestToolHandler_UnknownTool_ReturnsNotFoundError(t *testing.T) {
	h := newTestToolHandler(t)

	_, err := h.HandleToolCall("c1", "nonexistent_tool", json.RawMessage(`{}`))
	require.Error(t, err)

	var nfe *domain.NotFoundError
	require.ErrorAs(t, err, &nfe)
	assert.Equal(t, "tool", nfe.Resource)
}

func TestToolHandler_Authorization_RejectsUnknownAgent(t *testing.T) {
	h := newTestToolHandler(t)
	orgChart := config.NewOrgChart()
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, nil))
	h.SetOrgChart(orgChart)

	h.Register("get_config", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	_, err := h.HandleToolCallWithContext("main", "c1", "get_config", "aid-unknown-00000001", json.RawMessage(`{}`))
	require.Error(t, err)
	var ade *domain.AccessDeniedError
	assert.ErrorAs(t, err, &ade)
}

func TestToolHandler_Authorization_RejectsToolNotInWhitelist(t *testing.T) {
	h := newTestToolHandler(t)

	// Register an admin-only tool
	h.Register("create_team", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "created"})
	})

	// Child team (not "main") calling admin-only tool
	_, err := h.HandleToolCallWithContext("team-child", "c1", "create_team", "", json.RawMessage(`{}`))
	require.Error(t, err)
	var ade *domain.AccessDeniedError
	assert.ErrorAs(t, err, &ade)
}

func TestToolHandler_Authorization_AllowsMainTeamAllTools(t *testing.T) {
	h := newTestToolHandler(t)

	// Register an admin-only tool
	h.Register("create_team", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "created"})
	})

	// Main team can call any tool
	result, err := h.HandleToolCallWithContext("main", "c1", "create_team", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)
}

func TestToolHandler_Authorization_AllowsChildTeamRestrictedTools(t *testing.T) {
	h := newTestToolHandler(t)

	// Register a whitelisted tool
	h.Register("get_task_status", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "running"})
	})

	// Child team can call whitelisted tool
	result, err := h.HandleToolCallWithContext("team-child", "c1", "get_task_status", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)
}

func TestToolHandler_ToolCallLogging(t *testing.T) {
	// This test verifies the tool handler logs team_id and agent_aid.
	// We just verify the call succeeds since log output goes to slog stdout.
	h := newTestToolHandler(t)
	h.Register("get_config", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	result, err := h.HandleToolCallWithContext("main", "c1", "get_config", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)
}

func TestToolHandler_Authorization_RejectsEmptyTeamID(t *testing.T) {
	h := newTestToolHandler(t)
	h.Register("get_config", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	// Empty teamID must be rejected regardless of the tool being called.
	_, err := h.HandleToolCallWithContext("", "c1", "get_config", "", json.RawMessage(`{}`))
	require.Error(t, err)
	var ade *domain.AccessDeniedError
	assert.ErrorAs(t, err, &ade)
	assert.Contains(t, ade.Message, "teamID is required")
}

func TestToolHandler_HandleToolCall_HandlerError(t *testing.T) {
	h := newTestToolHandler(t)

	h.Register("fail_tool", func(args json.RawMessage) (json.RawMessage, error) {
		return nil, assert.AnError
	})

	result, err := h.HandleToolCall("call-003", "fail_tool", json.RawMessage(`{}`))
	assert.Error(t, err)
	assert.Nil(t, result)
}

func TestToolHandler_Register_MultipleTools(t *testing.T) {
	h := newTestToolHandler(t)

	h.Register("tool_a", func(args json.RawMessage) (json.RawMessage, error) { return nil, nil })
	h.Register("tool_b", func(args json.RawMessage) (json.RawMessage, error) { return nil, nil })
	h.Register("tool_c", func(args json.RawMessage) (json.RawMessage, error) { return nil, nil })

	tools := h.RegisteredTools()
	assert.Len(t, tools, 3)
	assert.Contains(t, tools, "tool_a")
	assert.Contains(t, tools, "tool_b")
	assert.Contains(t, tools, "tool_c")
}

func TestToolHandler_Authorization_RejectsAgentFromWrongTeam(t *testing.T) {
	h := newTestToolHandler(t)

	// Build OrgChart with a team and an agent belonging to that team.
	orgChart := config.NewOrgChart()
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
	}
	teams := map[string]*domain.Team{
		"team-alpha": {
			LeaderAID: "aid-asst-main0001",
			Agents: []domain.Agent{
				{AID: "aid-alpha-worker01", Name: "Worker"},
			},
		},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, teams))
	h.SetOrgChart(orgChart)

	// Register a whitelisted child-team tool.
	h.Register("get_task_status", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	// Agent belongs to team-alpha but calls from team-beta → should be rejected.
	_, err := h.HandleToolCallWithContext("team-beta", "c1", "get_task_status", "aid-alpha-worker01", json.RawMessage(`{}`))
	require.Error(t, err)
	var ade *domain.AccessDeniedError
	assert.ErrorAs(t, err, &ade)
	assert.Contains(t, ade.Message, "does not belong to team")
}

func TestToolHandler_Authorization_AllowsAgentFromCorrectTeam(t *testing.T) {
	h := newTestToolHandler(t)

	// Build OrgChart with a team and an agent belonging to that team.
	orgChart := config.NewOrgChart()
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
	}
	teams := map[string]*domain.Team{
		"team-alpha": {
			LeaderAID: "aid-asst-main0001",
			Agents: []domain.Agent{
				{AID: "aid-alpha-worker01", Name: "Worker"},
			},
		},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, teams))
	h.SetOrgChart(orgChart)

	// Register a whitelisted child-team tool.
	h.Register("get_task_status", func(args json.RawMessage) (json.RawMessage, error) {
		return json.Marshal(map[string]string{"status": "ok"})
	})

	// Agent belongs to team-alpha and calls from team-alpha → should succeed.
	result, err := h.HandleToolCallWithContext("team-alpha", "c1", "get_task_status", "aid-alpha-worker01", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)
}

func TestToolHandler_HandleToolCall_PassesArguments(t *testing.T) {
	h := newTestToolHandler(t)

	var receivedArgs json.RawMessage
	h.Register("echo", func(args json.RawMessage) (json.RawMessage, error) {
		receivedArgs = args
		return args, nil
	})

	input := json.RawMessage(`{"key":"value"}`)
	result, err := h.HandleToolCall("call-004", "echo", input)
	require.NoError(t, err)

	assert.JSONEq(t, `{"key":"value"}`, string(receivedArgs))
	assert.JSONEq(t, `{"key":"value"}`, string(result))
}
