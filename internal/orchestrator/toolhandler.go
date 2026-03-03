package orchestrator

import (
	"encoding/json"
	"log/slog"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// mainTeamID is the reserved team ID for the main assistant container.
const mainTeamID = "main"

// childTeamTools is the set of tools permitted for child team containers.
// Subset of all tools — child teams cannot perform admin-level operations.
var childTeamTools = map[string]bool{
	"dispatch_subtask":   true,
	"get_task_status":    true,
	"cancel_task":        true,
	"list_tasks":         true,
	"get_member_status":  true,
	"get_team":           true,
	"list_teams":         true,
	"get_config":         true,
	"get_system_status":  true,
}

// ToolHandler dispatches SDK tool calls to the appropriate handler function.
// Implements domain.SDKToolHandler.
type ToolHandler struct {
	handlers map[string]ToolFunc
	orgChart domain.OrgChart
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

// SetOrgChart wires in the OrgChart for agent-ownership authorization checks.
func (h *ToolHandler) SetOrgChart(orgChart domain.OrgChart) {
	h.orgChart = orgChart
}

// Register adds a tool handler for the given tool name.
func (h *ToolHandler) Register(name string, fn ToolFunc) {
	h.handlers[name] = fn
}

// HandleToolCall dispatches a tool call to the registered handler.
// This is the unauthenticated entry point used by tests and legacy code.
func (h *ToolHandler) HandleToolCall(callID string, toolName string, args json.RawMessage) (json.RawMessage, error) {
	return h.HandleToolCallWithContext(mainTeamID, callID, toolName, "", args)
}

// HandleToolCallWithContext dispatches a tool call with authorization.
// teamID is the calling container's team ID and MUST NOT be empty.
// agentAID is the agent invoking the tool (may be empty for system/test calls).
// Authorization rules:
//   - Main team (teamID == "main") has access to all tools.
//   - Child teams have access to the childTeamTools whitelist only.
//   - Empty teamID is always rejected — callers must supply an explicit team ID.
//   - If an OrgChart is set, agentAID is validated to belong to the calling team.
func (h *ToolHandler) HandleToolCallWithContext(teamID, callID, toolName, agentAID string, args json.RawMessage) (json.RawMessage, error) {
	// Reject empty teamID before any logging to avoid leaking tool names in error
	// messages to unauthenticated callers.
	if teamID == "" {
		h.logger.Warn("tool call rejected: empty teamID",
			"call_id", callID,
			"tool_name", toolName,
		)
		return nil, &domain.AccessDeniedError{
			Resource: "tool",
			Message:  "teamID is required; unauthenticated tool calls are not permitted",
		}
	}

	h.logger.Info("handling tool call",
		"call_id", callID,
		"tool_name", toolName,
		"team_id", teamID,
		"agent_aid", agentAID,
	)

	// Authorization: child teams have restricted tool access.
	if teamID != mainTeamID {
		if !childTeamTools[toolName] {
			h.logger.Warn("tool access denied",
				"call_id", callID,
				"tool_name", toolName,
				"team_id", teamID,
			)
			return nil, &domain.AccessDeniedError{
				Resource: "tool",
				Message:  toolName + " is not available to child team containers",
			}
		}
	}

	// If OrgChart is set, validate agent existence and team membership.
	if h.orgChart != nil && agentAID != "" {
		// Verify the agent exists in the OrgChart (master config or team config).
		if _, err := h.orgChart.GetAgentByAID(agentAID); err != nil {
			h.logger.Warn("tool call from unknown agent",
				"call_id", callID,
				"agent_aid", agentAID,
				"team_id", teamID,
			)
			return nil, &domain.AccessDeniedError{
				Resource: "agent",
				Message:  "agent " + agentAID + " is not known to the orchestrator",
			}
		}
		// For child teams, also verify the agent belongs to the calling team.
		// Main team agents (assistant, top-level leads) exist in the OrgChart
		// but don't belong to any team — they live in the master config.
		if teamID != mainTeamID {
			agentTeam, err := h.orgChart.GetTeamForAgent(agentAID)
			if err != nil || agentTeam.Slug != teamID {
				teamSlug := ""
				if agentTeam != nil {
					teamSlug = agentTeam.Slug
				}
				h.logger.Warn("tool call from agent not belonging to calling team",
					"call_id", callID,
					"agent_aid", agentAID,
					"team_id", teamID,
					"agent_team", teamSlug,
				)
				return nil, &domain.AccessDeniedError{
					Resource: "agent",
					Message:  "agent " + agentAID + " does not belong to team " + teamID,
				}
			}
		}
	}

	fn, ok := h.handlers[toolName]
	if !ok {
		return nil, &domain.NotFoundError{Resource: "tool", ID: toolName}
	}

	result, err := fn(args)
	if err != nil {
		h.logger.Error("tool call failed",
			"call_id", callID,
			"tool_name", toolName,
			"team_id", teamID,
			"agent_aid", agentAID,
			"error", err,
		)
		return nil, err
	}

	h.logger.Info("tool call completed",
		"call_id", callID,
		"tool_name", toolName,
		"team_id", teamID,
		"agent_aid", agentAID,
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
