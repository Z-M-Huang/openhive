package ws

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestContainerInitMsg_RoundTrip(t *testing.T) {
	original := &ContainerInitMsg{
		IsMainAssistant: true,
		TeamConfig:      json.RawMessage(`{"slug":"my-team"}`),
		Agents: []AgentInitConfig{
			{
				AID:  "aid-agent-001",
				Name: "helper",
				Provider: ProviderConfig{
					Type:       "oauth",
					OAuthToken: "token-xyz",
				},
				ModelTier: "sonnet",
			},
		},
		Secrets:    map[string]string{"GITHUB_TOKEN": "ghp_abc"},
		MCPServers: []MCPServerConfig{{Name: "github", Command: "github-mcp"}},
	}

	data, err := EncodeMessage(MsgTypeContainerInit, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeContainerInit, msgType)

	msg, ok := payload.(*ContainerInitMsg)
	require.True(t, ok)
	assert.True(t, msg.IsMainAssistant)
	assert.Len(t, msg.Agents, 1)
	assert.Equal(t, "aid-agent-001", msg.Agents[0].AID)
	assert.Equal(t, "token-xyz", msg.Agents[0].Provider.OAuthToken)
	assert.Equal(t, "ghp_abc", msg.Secrets["GITHUB_TOKEN"])
	assert.Len(t, msg.MCPServers, 1)
}

func TestTaskDispatchMsg_RoundTrip(t *testing.T) {
	original := &TaskDispatchMsg{
		TaskID:    "task-001",
		AgentAID:  "aid-agent-001",
		Prompt:    "Write tests for the auth module",
		SessionID: "sess-001",
		WorkDir:   "/workspace/tasks/task-001",
	}

	data, err := EncodeMessage(MsgTypeTaskDispatch, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeTaskDispatch, msgType)

	msg, ok := payload.(*TaskDispatchMsg)
	require.True(t, ok)
	assert.Equal(t, "task-001", msg.TaskID)
	assert.Equal(t, "aid-agent-001", msg.AgentAID)
	assert.Equal(t, "Write tests for the auth module", msg.Prompt)
	assert.Equal(t, "sess-001", msg.SessionID)
	assert.Equal(t, "/workspace/tasks/task-001", msg.WorkDir)
}

func TestHeartbeatMsg_RoundTrip(t *testing.T) {
	original := &HeartbeatMsg{
		TeamID: "tid-team-001",
		Agents: []AgentStatus{
			{
				AID:            "aid-agent-001",
				Status:         "working",
				Detail:         "processing task-001",
				ElapsedSeconds: 30.5,
				MemoryMB:       128.7,
			},
			{
				AID:            "aid-agent-002",
				Status:         "idle",
				ElapsedSeconds: 0,
				MemoryMB:       64.2,
			},
		},
	}

	data, err := EncodeMessage(MsgTypeHeartbeat, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeHeartbeat, msgType)

	msg, ok := payload.(*HeartbeatMsg)
	require.True(t, ok)
	assert.Equal(t, "tid-team-001", msg.TeamID)
	assert.Len(t, msg.Agents, 2)
	assert.Equal(t, "working", msg.Agents[0].Status)
	assert.InDelta(t, 30.5, msg.Agents[0].ElapsedSeconds, 0.01)
}

func TestToolCallMsg_RoundTrip(t *testing.T) {
	original := &ToolCallMsg{
		CallID:    "call-001",
		ToolName:  "create_team",
		Arguments: json.RawMessage(`{"slug":"new-team","leader_aid":"aid-lead-001"}`),
		AgentAID:  "aid-agent-001",
	}

	data, err := EncodeMessage(MsgTypeToolCall, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeToolCall, msgType)

	msg, ok := payload.(*ToolCallMsg)
	require.True(t, ok)
	assert.Equal(t, "call-001", msg.CallID)
	assert.Equal(t, "create_team", msg.ToolName)
	assert.Contains(t, string(msg.Arguments), "new-team")
}

func TestToolResultMsg_SuccessRoundTrip(t *testing.T) {
	original := &ToolResultMsg{
		CallID: "call-001",
		Result: json.RawMessage(`{"team_id":"tid-team-001"}`),
	}

	data, err := EncodeMessage(MsgTypeToolResult, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeToolResult, msgType)

	msg, ok := payload.(*ToolResultMsg)
	require.True(t, ok)
	assert.Equal(t, "call-001", msg.CallID)
	assert.Contains(t, string(msg.Result), "tid-team-001")
	assert.Empty(t, msg.ErrorCode)
	assert.Empty(t, msg.ErrorMessage)
}

func TestToolResultMsg_ErrorRoundTrip(t *testing.T) {
	original := &ToolResultMsg{
		CallID:       "call-002",
		ErrorCode:    "NOT_FOUND",
		ErrorMessage: "team not found: my-team",
	}

	data, err := EncodeMessage(MsgTypeToolResult, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeToolResult, msgType)

	msg, ok := payload.(*ToolResultMsg)
	require.True(t, ok)
	assert.Equal(t, "NOT_FOUND", msg.ErrorCode)
	assert.Equal(t, "team not found: my-team", msg.ErrorMessage)
	assert.Nil(t, msg.Result)
}

func TestShutdownMsg_RoundTrip(t *testing.T) {
	original := &ShutdownMsg{
		Reason:  "scaling down",
		Timeout: 30,
	}

	data, err := EncodeMessage(MsgTypeShutdown, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeShutdown, msgType)

	msg, ok := payload.(*ShutdownMsg)
	require.True(t, ok)
	assert.Equal(t, "scaling down", msg.Reason)
	assert.Equal(t, 30, msg.Timeout)
}

func TestReadyMsg_RoundTrip(t *testing.T) {
	original := &ReadyMsg{
		TeamID:     "tid-team-001",
		AgentCount: 3,
	}

	data, err := EncodeMessage(MsgTypeReady, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeReady, msgType)

	msg, ok := payload.(*ReadyMsg)
	require.True(t, ok)
	assert.Equal(t, "tid-team-001", msg.TeamID)
	assert.Equal(t, 3, msg.AgentCount)
}

func TestTaskResultMsg_RoundTrip(t *testing.T) {
	original := &TaskResultMsg{
		TaskID:       "task-001",
		AgentAID:     "aid-agent-001",
		Status:       "completed",
		Result:       "all tests pass",
		FilesCreated: []string{"src/auth.go", "src/auth_test.go"},
		Duration:     30 * time.Second,
	}

	data, err := EncodeMessage(MsgTypeTaskResult, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeTaskResult, msgType)

	msg, ok := payload.(*TaskResultMsg)
	require.True(t, ok)
	assert.Equal(t, "task-001", msg.TaskID)
	assert.Equal(t, "completed", msg.Status)
	assert.Len(t, msg.FilesCreated, 2)
}

func TestEscalationMsg_RoundTrip(t *testing.T) {
	original := &EscalationMsg{
		TaskID:   "task-001",
		AgentAID: "aid-agent-001",
		Reason:   "exceeded max retries",
		Context:  "3 build failures",
	}

	data, err := EncodeMessage(MsgTypeEscalation, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeEscalation, msgType)

	msg, ok := payload.(*EscalationMsg)
	require.True(t, ok)
	assert.Equal(t, "exceeded max retries", msg.Reason)
}

func TestStatusUpdateMsg_RoundTrip(t *testing.T) {
	original := &StatusUpdateMsg{
		AgentAID: "aid-agent-001",
		Status:   "working",
		Detail:   "executing task-001",
	}

	data, err := EncodeMessage(MsgTypeStatusUpdate, original)
	require.NoError(t, err)

	msgType, payload, err := ParseMessage(data)
	require.NoError(t, err)
	assert.Equal(t, MsgTypeStatusUpdate, msgType)

	msg, ok := payload.(*StatusUpdateMsg)
	require.True(t, ok)
	assert.Equal(t, "aid-agent-001", msg.AgentAID)
	assert.Equal(t, "working", msg.Status)
}
