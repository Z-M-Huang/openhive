package domain

import (
	"encoding/json"
	"time"
)

// Team represents a team of agents running in a Docker container.
type Team struct {
	TID             string            `json:"tid" yaml:"tid"`
	Slug            string            `json:"slug" yaml:"slug"`
	ParentSlug      string            `json:"parent_slug,omitempty" yaml:"parent_slug,omitempty"`
	LeaderAID       string            `json:"leader_aid" yaml:"leader_aid"`
	Children        []string          `json:"children,omitempty" yaml:"children,omitempty"`
	Agents          []Agent           `json:"agents,omitempty" yaml:"agents,omitempty"`
	Skills          []Skill           `json:"skills,omitempty" yaml:"skills,omitempty"`
	MCPServers      []MCPServer       `json:"mcp_servers,omitempty" yaml:"mcp_servers,omitempty"`
	EnvVars         map[string]string `json:"env_vars,omitempty" yaml:"env_vars,omitempty"`
	ContainerConfig ContainerConfig   `json:"container_config,omitempty" yaml:"container_config,omitempty"`
}

// Agent represents a Claude Agent SDK instance.
type Agent struct {
	AID            string   `json:"aid" yaml:"aid"`
	Name           string   `json:"name" yaml:"name"`
	RoleFile       string   `json:"role_file,omitempty" yaml:"role_file,omitempty"`
	PromptFile     string   `json:"prompt_file,omitempty" yaml:"prompt_file,omitempty"`
	Provider       string   `json:"provider,omitempty" yaml:"provider,omitempty"`
	ModelTier      string   `json:"model_tier,omitempty" yaml:"model_tier,omitempty"`
	Skills         []string `json:"skills,omitempty" yaml:"skills,omitempty"`
	MaxTurns       int      `json:"max_turns,omitempty" yaml:"max_turns,omitempty"`
	TimeoutMinutes int      `json:"timeout_minutes,omitempty" yaml:"timeout_minutes,omitempty"`
	LeadsTeam      string   `json:"leads_team,omitempty" yaml:"leads_team,omitempty"`
}

// Provider represents an AI provider configuration.
type Provider struct {
	Name       string            `json:"name" yaml:"name"`
	Type       string            `json:"type" yaml:"type"`
	BaseURL    string            `json:"base_url,omitempty" yaml:"base_url,omitempty"`
	APIKey     string            `json:"api_key,omitempty" yaml:"api_key,omitempty"`
	OAuthToken string            `json:"oauth_token,omitempty" yaml:"oauth_token,omitempty"`
	Models     map[string]string `json:"models,omitempty" yaml:"models,omitempty"`
}

// Skill represents a skill assigned to an agent.
type Skill struct {
	Name                 string   `json:"name" yaml:"name"`
	Description          string   `json:"description,omitempty" yaml:"description,omitempty"`
	ModelTier            string   `json:"model_tier,omitempty" yaml:"model_tier,omitempty"`
	Tools                []string `json:"tools,omitempty" yaml:"tools,omitempty"`
	SystemPromptAddition string   `json:"system_prompt_addition,omitempty" yaml:"system_prompt_addition,omitempty"`
}

// Task represents a unit of work dispatched to a team.
type Task struct {
	ID          string     `json:"id"`
	ParentID    string     `json:"parent_id,omitempty"`
	TeamSlug    string     `json:"team_slug"`
	AgentAID    string     `json:"agent_aid,omitempty"`
	Status      TaskStatus `json:"status"`
	Prompt      string     `json:"prompt"`
	Result      string     `json:"result,omitempty"`
	Error       string     `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// TaskResult represents the result of a completed task.
type TaskResult struct {
	TaskID       string        `json:"task_id"`
	Status       TaskStatus    `json:"status"`
	Result       string        `json:"result,omitempty"`
	Error        string        `json:"error,omitempty"`
	FilesCreated []string      `json:"files_created,omitempty"`
	Duration     time.Duration `json:"duration"`
}

// Message represents a chat message.
type Message struct {
	ID        string    `json:"id"`
	ChatJID   string    `json:"chat_jid"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
}

// ChatSession represents an active chat session.
type ChatSession struct {
	ChatJID            string    `json:"chat_jid"`
	ChannelType        string    `json:"channel_type"`
	LastTimestamp       time.Time `json:"last_timestamp"`
	LastAgentTimestamp  time.Time `json:"last_agent_timestamp"`
	SessionID          string    `json:"session_id,omitempty"`
	AgentAID           string    `json:"agent_aid,omitempty"`
}

// LogEntry represents a structured log entry stored in the database.
type LogEntry struct {
	ID         uint            `json:"id"`
	Level      LogLevel        `json:"level"`
	Component  string          `json:"component"`
	Action     string          `json:"action"`
	Message    string          `json:"message"`
	Params     json.RawMessage `json:"params,omitempty"`
	TeamName   string          `json:"team_name,omitempty"`
	TaskID     string          `json:"task_id,omitempty"`
	AgentName  string          `json:"agent_name,omitempty"`
	RequestID  string          `json:"request_id,omitempty"`
	Error      string          `json:"error,omitempty"`
	DurationMs int64           `json:"duration_ms,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
}

// MCPServer represents an MCP server configuration.
type MCPServer struct {
	Name    string            `json:"name" yaml:"name"`
	Command string            `json:"command" yaml:"command"`
	Args    []string          `json:"args,omitempty" yaml:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty" yaml:"env,omitempty"`
}

// ContainerConfig holds per-container Docker configuration.
type ContainerConfig struct {
	MaxMemory      string            `json:"max_memory,omitempty" yaml:"max_memory,omitempty"`
	MaxOldSpace    int               `json:"max_old_space,omitempty" yaml:"max_old_space,omitempty"`
	Env            map[string]string `json:"env,omitempty" yaml:"env,omitempty"`
}

// Event represents a system event for the event bus.
type Event struct {
	Type    EventType   `json:"type"`
	Payload interface{} `json:"payload"`
}
