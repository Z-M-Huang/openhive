package orchestrator

import (
	"encoding/json"
	"log/slog"
	"os"
	"testing"

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
	assert.Contains(t, err.Error(), "unknown tool")
	assert.Nil(t, result)
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
