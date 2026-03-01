package orchestrator

import (
	"encoding/json"
	"fmt"
	"log/slog"
)

// ToolHandler dispatches SDK tool calls to the appropriate handler function.
// Implements domain.SDKToolHandler.
type ToolHandler struct {
	handlers map[string]ToolFunc
	logger   *slog.Logger
}

// ToolFunc is a function that handles a specific SDK tool call.
type ToolFunc func(args json.RawMessage) (json.RawMessage, error)

// NewToolHandler creates a new tool handler.
func NewToolHandler(logger *slog.Logger) *ToolHandler {
	return &ToolHandler{
		handlers: make(map[string]ToolFunc),
		logger:   logger,
	}
}

// Register adds a tool handler for the given tool name.
func (h *ToolHandler) Register(name string, fn ToolFunc) {
	h.handlers[name] = fn
}

// HandleToolCall dispatches a tool call to the registered handler.
func (h *ToolHandler) HandleToolCall(callID string, toolName string, args json.RawMessage) (json.RawMessage, error) {
	h.logger.Info("handling tool call",
		"call_id", callID,
		"tool_name", toolName,
	)

	fn, ok := h.handlers[toolName]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", toolName)
	}

	result, err := fn(args)
	if err != nil {
		h.logger.Error("tool call failed",
			"call_id", callID,
			"tool_name", toolName,
			"error", err,
		)
		return nil, err
	}

	h.logger.Info("tool call completed",
		"call_id", callID,
		"tool_name", toolName,
	)

	return result, nil
}

// RegisteredTools returns the list of registered tool names.
func (h *ToolHandler) RegisteredTools() []string {
	names := make([]string, 0, len(h.handlers))
	for name := range h.handlers {
		names = append(names, name)
	}
	return names
}
