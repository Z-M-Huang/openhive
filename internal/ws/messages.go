package ws

import (
	"encoding/json"
	"time"
)

// Message type constants
const (
	// Go-to-Container message types
	MsgTypeContainerInit = "container_init"
	MsgTypeTaskDispatch  = "task_dispatch"
	MsgTypeShutdown      = "shutdown"
	MsgTypeToolResult    = "tool_result"

	// Container-to-Go message types
	MsgTypeReady        = "ready"
	MsgTypeHeartbeat    = "heartbeat"
	MsgTypeTaskResult   = "task_result"
	MsgTypeEscalation   = "escalation"
	MsgTypeToolCall     = "tool_call"
	MsgTypeStatusUpdate = "status_update"
)

// WS error code constants
const (
	WSErrorNotFound           = "NOT_FOUND"
	WSErrorValidation         = "VALIDATION_ERROR"
	WSErrorConflict           = "CONFLICT"
	WSErrorEncryptionLocked   = "ENCRYPTION_LOCKED"
	WSErrorInternal           = "INTERNAL_ERROR"
)

// WSMessage is the envelope for all WebSocket messages.
type WSMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// --- Go-to-Container Messages ---

// ContainerInitMsg carries initialization data for a team container.
type ContainerInitMsg struct {
	IsMainAssistant bool              `json:"is_main_assistant"`
	TeamConfig      json.RawMessage   `json:"team_config"`
	Agents          []AgentInitConfig `json:"agents"`
	Secrets         map[string]string `json:"secrets,omitempty"`
	MCPServers      []MCPServerConfig `json:"mcp_servers,omitempty"`
}

// AgentInitConfig holds flattened agent config sent to containers.
type AgentInitConfig struct {
	AID        string         `json:"aid"`
	Name       string         `json:"name"`
	RoleFile   string         `json:"role_file,omitempty"`
	PromptFile string         `json:"prompt_file,omitempty"`
	Provider   ProviderConfig `json:"provider"`
	ModelTier  string         `json:"model_tier"`
	Skills     []string       `json:"skills,omitempty"`
}

// ProviderConfig holds resolved provider credentials for an agent.
type ProviderConfig struct {
	Type       string `json:"type"`
	APIKey     string `json:"api_key,omitempty"`
	APIURL     string `json:"api_url,omitempty"`
	OAuthToken string `json:"oauth_token,omitempty"`
}

// MCPServerConfig holds MCP server configuration.
type MCPServerConfig struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// TaskDispatchMsg instructs a container to execute a task.
type TaskDispatchMsg struct {
	TaskID    string `json:"task_id"`
	AgentAID  string `json:"agent_aid"`
	Prompt    string `json:"prompt"`
	SessionID string `json:"session_id,omitempty"`
	WorkDir   string `json:"work_dir,omitempty"`
}

// ShutdownMsg instructs a container to shut down.
type ShutdownMsg struct {
	Reason  string `json:"reason"`
	Timeout int    `json:"timeout"`
}

// ToolResultMsg carries the result of a tool call back to the container.
type ToolResultMsg struct {
	CallID       string          `json:"call_id"`
	Result       json.RawMessage `json:"result,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
}

// --- Container-to-Go Messages ---

// ReadyMsg signals that a container has initialized and is ready.
type ReadyMsg struct {
	TeamID     string `json:"team_id"`
	AgentCount int    `json:"agent_count"`
}

// HeartbeatMsg carries periodic health data from a container.
type HeartbeatMsg struct {
	TeamID string        `json:"team_id"`
	Agents []AgentStatus `json:"agents"`
}

// AgentStatus represents agent health in a heartbeat.
type AgentStatus struct {
	AID            string  `json:"aid"`
	Status         string  `json:"status"`
	Detail         string  `json:"detail,omitempty"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	MemoryMB       float64 `json:"memory_mb"`
}

// TaskResultMsg carries the result of a completed task.
type TaskResultMsg struct {
	TaskID       string        `json:"task_id"`
	AgentAID     string        `json:"agent_aid"`
	Status       string        `json:"status"`
	Result       string        `json:"result,omitempty"`
	Error        string        `json:"error,omitempty"`
	FilesCreated []string      `json:"files_created,omitempty"`
	Duration     time.Duration `json:"duration"`
}

// EscalationMsg requests that a task be escalated to a supervisor.
type EscalationMsg struct {
	TaskID   string `json:"task_id"`
	AgentAID string `json:"agent_aid"`
	Reason   string `json:"reason"`
	Context  string `json:"context,omitempty"`
}

// ToolCallMsg is sent by a container when an agent invokes an SDK tool.
type ToolCallMsg struct {
	CallID    string          `json:"call_id"`
	ToolName  string          `json:"tool_name"`
	Arguments json.RawMessage `json:"arguments"`
	AgentAID  string          `json:"agent_aid"`
}

// StatusUpdateMsg carries an agent status change notification.
type StatusUpdateMsg struct {
	AgentAID string `json:"agent_aid"`
	Status   string `json:"status"`
	Detail   string `json:"detail,omitempty"`
}
