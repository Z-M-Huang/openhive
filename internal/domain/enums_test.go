package domain

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskStatus_String(t *testing.T) {
	tests := []struct {
		status   TaskStatus
		expected string
	}{
		{TaskStatusPending, "pending"},
		{TaskStatusRunning, "running"},
		{TaskStatusCompleted, "completed"},
		{TaskStatusFailed, "failed"},
		{TaskStatusCancelled, "cancelled"},
		{TaskStatus(99), "TaskStatus(99)"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.expected, tt.status.String())
	}
}

func TestTaskStatus_Validate(t *testing.T) {
	assert.NoError(t, TaskStatusPending.Validate())
	assert.NoError(t, TaskStatusCancelled.Validate())
	assert.Error(t, TaskStatus(99).Validate())
}

func TestParseTaskStatus(t *testing.T) {
	s, err := ParseTaskStatus("pending")
	require.NoError(t, err)
	assert.Equal(t, TaskStatusPending, s)

	s, err = ParseTaskStatus("cancelled")
	require.NoError(t, err)
	assert.Equal(t, TaskStatusCancelled, s)

	_, err = ParseTaskStatus("invalid")
	assert.Error(t, err)
}

func TestEventType_String(t *testing.T) {
	tests := []struct {
		et       EventType
		expected string
	}{
		{EventTypeTaskCreated, "task_created"},
		{EventTypeConfigChanged, "config_changed"},
		{EventTypeChannelMessage, "channel_message"},
		{EventType(99), "EventType(99)"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.expected, tt.et.String())
	}
}

func TestEventType_Validate(t *testing.T) {
	assert.NoError(t, EventTypeTaskCreated.Validate())
	assert.NoError(t, EventTypeChannelMessage.Validate())
	assert.Error(t, EventType(99).Validate())
}

func TestParseEventType(t *testing.T) {
	et, err := ParseEventType("task_created")
	require.NoError(t, err)
	assert.Equal(t, EventTypeTaskCreated, et)

	_, err = ParseEventType("invalid")
	assert.Error(t, err)
}

func TestEventType_MarshalJSON(t *testing.T) {
	tests := []struct {
		et       EventType
		expected string
	}{
		{EventTypeTaskCreated, `"task_created"`},
		{EventTypeLogEntry, `"log_entry"`},
		{EventTypeChannelMessage, `"channel_message"`},
		{EventTypeConfigChanged, `"config_changed"`},
	}
	for _, tt := range tests {
		data, err := json.Marshal(tt.et)
		require.NoError(t, err)
		assert.Equal(t, tt.expected, string(data))
	}

	// Unknown EventType should return an error.
	_, err := json.Marshal(EventType(999))
	assert.Error(t, err)
}

func TestEventType_UnmarshalJSON(t *testing.T) {
	tests := []struct {
		input    string
		expected EventType
	}{
		{`"task_created"`, EventTypeTaskCreated},
		{`"log_entry"`, EventTypeLogEntry},
		{`"channel_message"`, EventTypeChannelMessage},
	}
	for _, tt := range tests {
		var et EventType
		err := json.Unmarshal([]byte(tt.input), &et)
		require.NoError(t, err)
		assert.Equal(t, tt.expected, et)
	}

	// Invalid string value.
	var et EventType
	err := json.Unmarshal([]byte(`"nonexistent_type"`), &et)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid event type")

	// Non-string JSON (numeric) should fail.
	err = json.Unmarshal([]byte(`42`), &et)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "string")
}

func TestEventType_MarshalJSON_Roundtrip(t *testing.T) {
	// Wrap in a struct to test realistic JSON serialization.
	type wrapper struct {
		Type EventType `json:"type"`
	}

	original := wrapper{Type: EventTypeHeartbeatReceived}
	data, err := json.Marshal(original)
	require.NoError(t, err)
	assert.Contains(t, string(data), `"heartbeat_received"`)

	var decoded wrapper
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)
	assert.Equal(t, original.Type, decoded.Type)
}

func TestProviderType_String(t *testing.T) {
	assert.Equal(t, "oauth", ProviderTypeOAuth.String())
	assert.Equal(t, "anthropic_direct", ProviderTypeAnthropicDirect.String())
	assert.Contains(t, ProviderType(99).String(), "ProviderType(99)")
}

func TestProviderType_Validate(t *testing.T) {
	assert.NoError(t, ProviderTypeOAuth.Validate())
	assert.NoError(t, ProviderTypeAnthropicDirect.Validate())
	assert.Error(t, ProviderType(99).Validate())
}

func TestParseProviderType(t *testing.T) {
	pt, err := ParseProviderType("oauth")
	require.NoError(t, err)
	assert.Equal(t, ProviderTypeOAuth, pt)

	pt, err = ParseProviderType("anthropic_direct")
	require.NoError(t, err)
	assert.Equal(t, ProviderTypeAnthropicDirect, pt)

	_, err = ParseProviderType("invalid")
	assert.Error(t, err)
}

func TestLogLevel_String(t *testing.T) {
	assert.Equal(t, "debug", LogLevelDebug.String())
	assert.Equal(t, "error", LogLevelError.String())
	assert.Contains(t, LogLevel(99).String(), "LogLevel(99)")
}

func TestLogLevel_Validate(t *testing.T) {
	assert.NoError(t, LogLevelDebug.Validate())
	assert.NoError(t, LogLevelError.Validate())
	assert.Error(t, LogLevel(99).Validate())
}

func TestParseLogLevel(t *testing.T) {
	ll, err := ParseLogLevel("debug")
	require.NoError(t, err)
	assert.Equal(t, LogLevelDebug, ll)

	_, err = ParseLogLevel("invalid")
	assert.Error(t, err)
}

func TestContainerState_String(t *testing.T) {
	assert.Equal(t, "created", ContainerStateCreated.String())
	assert.Equal(t, "running", ContainerStateRunning.String())
	assert.Equal(t, "error", ContainerStateError.String())
	assert.Contains(t, ContainerState(99).String(), "ContainerState(99)")
}

func TestContainerState_Validate(t *testing.T) {
	assert.NoError(t, ContainerStateCreated.Validate())
	assert.NoError(t, ContainerStateError.Validate())
	assert.Error(t, ContainerState(99).Validate())
}

func TestParseContainerState(t *testing.T) {
	cs, err := ParseContainerState("running")
	require.NoError(t, err)
	assert.Equal(t, ContainerStateRunning, cs)

	_, err = ParseContainerState("invalid")
	assert.Error(t, err)
}

func TestModelTier_String(t *testing.T) {
	assert.Equal(t, "haiku", ModelTierHaiku.String())
	assert.Equal(t, "sonnet", ModelTierSonnet.String())
	assert.Equal(t, "opus", ModelTierOpus.String())
	assert.Contains(t, ModelTier(99).String(), "ModelTier(99)")
}

func TestModelTier_Validate(t *testing.T) {
	assert.NoError(t, ModelTierHaiku.Validate())
	assert.NoError(t, ModelTierOpus.Validate())
	assert.Error(t, ModelTier(99).Validate())
}

func TestParseModelTier(t *testing.T) {
	mt, err := ParseModelTier("haiku")
	require.NoError(t, err)
	assert.Equal(t, ModelTierHaiku, mt)

	_, err = ParseModelTier("invalid")
	assert.Error(t, err)
}

func TestAgentStatusType_String(t *testing.T) {
	assert.Equal(t, "idle", AgentStatusIdle.String())
	assert.Equal(t, "busy", AgentStatusBusy.String())
	assert.Equal(t, "error", AgentStatusError.String())
	assert.Contains(t, AgentStatusType(99).String(), "AgentStatusType(99)")
}

func TestAgentStatusType_Validate(t *testing.T) {
	assert.NoError(t, AgentStatusIdle.Validate())
	assert.NoError(t, AgentStatusError.Validate())
	assert.Error(t, AgentStatusType(99).Validate())
}

func TestParseAgentStatusType(t *testing.T) {
	ast, err := ParseAgentStatusType("idle")
	require.NoError(t, err)
	assert.Equal(t, AgentStatusIdle, ast)

	_, err = ParseAgentStatusType("invalid")
	assert.Error(t, err)
}
