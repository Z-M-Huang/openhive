package domain

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTeam_JSONRoundTrip(t *testing.T) {
	team := Team{
		TID:        "tid-abc-123",
		Slug:       "my-team",
		ParentSlug: "parent",
		LeaderAID:  "aid-lead-001",
		Children:   []string{"child-a"},
		Agents: []Agent{
			{AID: "aid-agent-001", Name: "agent1"},
		},
	}

	data, err := json.Marshal(team)
	require.NoError(t, err)

	var decoded Team
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, team.TID, decoded.TID)
	assert.Equal(t, team.Slug, decoded.Slug)
	assert.Equal(t, team.ParentSlug, decoded.ParentSlug)
	assert.Equal(t, team.LeaderAID, decoded.LeaderAID)
	assert.Equal(t, team.Children, decoded.Children)
	assert.Len(t, decoded.Agents, 1)
	assert.Equal(t, team.Agents[0].AID, decoded.Agents[0].AID)
}

func TestTask_JSONRoundTrip(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	task := Task{
		ID:        "task-123",
		TeamSlug:  "my-team",
		AgentAID:  "aid-agent-001",
		Status:    TaskStatusRunning,
		Prompt:    "do something",
		CreatedAt: now,
		UpdatedAt: now,
	}

	data, err := json.Marshal(task)
	require.NoError(t, err)

	var decoded Task
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, task.ID, decoded.ID)
	assert.Equal(t, task.TeamSlug, decoded.TeamSlug)
	assert.Equal(t, task.AgentAID, decoded.AgentAID)
	assert.Equal(t, task.Status, decoded.Status)
	assert.Equal(t, task.Prompt, decoded.Prompt)
}

func TestMessage_JSONRoundTrip(t *testing.T) {
	msg := Message{
		ID:        "msg-1",
		ChatJID:   "cli:local",
		Role:      "user",
		Content:   "hello",
		Timestamp: time.Now().Truncate(time.Second),
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, msg.ID, decoded.ID)
	assert.Equal(t, msg.ChatJID, decoded.ChatJID)
	assert.Equal(t, msg.Role, decoded.Role)
	assert.Equal(t, msg.Content, decoded.Content)
}

func TestLogEntry_JSONRoundTrip(t *testing.T) {
	entry := LogEntry{
		Level:     LogLevelInfo,
		Component: "api",
		Action:    "request",
		Message:   "handled request",
		Params:    json.RawMessage(`{"path":"/health"}`),
		CreatedAt: time.Now().Truncate(time.Second),
	}

	data, err := json.Marshal(entry)
	require.NoError(t, err)

	var decoded LogEntry
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, entry.Level, decoded.Level)
	assert.Equal(t, entry.Component, decoded.Component)
	assert.Equal(t, entry.Action, decoded.Action)
	assert.Equal(t, entry.Message, decoded.Message)
	assert.JSONEq(t, string(entry.Params), string(decoded.Params))
}

func TestEvent_Fields(t *testing.T) {
	event := Event{
		Type:    EventTypeTaskCreated,
		Payload: map[string]string{"task_id": "123"},
	}
	assert.Equal(t, EventTypeTaskCreated, event.Type)
	payload, ok := event.Payload.(map[string]string)
	require.True(t, ok)
	assert.Equal(t, "123", payload["task_id"])
}

func TestChatSession_JSONRoundTrip(t *testing.T) {
	session := ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
		SessionID:   "sess-1",
		AgentAID:    "aid-main-001",
	}

	data, err := json.Marshal(session)
	require.NoError(t, err)

	var decoded ChatSession
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, session.ChatJID, decoded.ChatJID)
	assert.Equal(t, session.ChannelType, decoded.ChannelType)
	assert.Equal(t, session.SessionID, decoded.SessionID)
	assert.Equal(t, session.AgentAID, decoded.AgentAID)
}

func TestTaskResult_JSONRoundTrip(t *testing.T) {
	result := TaskResult{
		TaskID:       "task-123",
		Status:       TaskStatusCompleted,
		Result:       "done",
		FilesCreated: []string{"file.go"},
		Duration:     5 * time.Second,
	}

	data, err := json.Marshal(result)
	require.NoError(t, err)

	var decoded TaskResult
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, result.TaskID, decoded.TaskID)
	assert.Equal(t, result.Status, decoded.Status)
	assert.Equal(t, result.Result, decoded.Result)
	assert.Equal(t, result.FilesCreated, decoded.FilesCreated)
}

func TestProvider_JSONRoundTrip(t *testing.T) {
	p := Provider{
		Name:   "default",
		Type:   "oauth",
		Models: map[string]string{"haiku": "claude-3-haiku", "sonnet": "claude-3-5-sonnet"},
	}

	data, err := json.Marshal(p)
	require.NoError(t, err)

	var decoded Provider
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, p.Name, decoded.Name)
	assert.Equal(t, p.Type, decoded.Type)
	assert.Equal(t, p.Models, decoded.Models)
}

func TestMCPServer_JSONRoundTrip(t *testing.T) {
	s := MCPServer{
		Name:    "github",
		Command: "npx",
		Args:    []string{"-y", "@modelcontextprotocol/server-github"},
		Env:     map[string]string{"GITHUB_TOKEN": "{secrets.GITHUB_TOKEN}"},
	}

	data, err := json.Marshal(s)
	require.NoError(t, err)

	var decoded MCPServer
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, s.Name, decoded.Name)
	assert.Equal(t, s.Command, decoded.Command)
	assert.Equal(t, s.Args, decoded.Args)
	assert.Equal(t, s.Env, decoded.Env)
}

func TestContainerConfig_JSONRoundTrip(t *testing.T) {
	c := ContainerConfig{
		MaxMemory:   "512m",
		MaxOldSpace: 384,
	}

	data, err := json.Marshal(c)
	require.NoError(t, err)

	var decoded ContainerConfig
	require.NoError(t, json.Unmarshal(data, &decoded))
	assert.Equal(t, c.MaxMemory, decoded.MaxMemory)
	assert.Equal(t, c.MaxOldSpace, decoded.MaxOldSpace)
}
