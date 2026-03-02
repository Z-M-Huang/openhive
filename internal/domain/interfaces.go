package domain

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// ConfigLoader handles config file I/O and watching.
type ConfigLoader interface {
	LoadMaster() (*MasterConfig, error)
	SaveMaster(cfg *MasterConfig) error
	LoadProviders() (map[string]Provider, error)
	SaveProviders(providers map[string]Provider) error
	LoadTeam(slug string) (*Team, error)
	SaveTeam(slug string, team *Team) error
	CreateTeamDir(slug string) error
	DeleteTeamDir(slug string) error
	ListTeams() ([]string, error)
	WatchMaster(callback func(*MasterConfig)) error
	WatchProviders(callback func(map[string]Provider)) error
	WatchTeam(slug string, callback func(*Team)) error
	StopWatching()
}

// MasterConfig holds the top-level system configuration.
type MasterConfig struct {
	System    SystemConfig    `json:"system" yaml:"system"`
	Assistant AssistantConfig `json:"assistant" yaml:"assistant"`
	Agents    []Agent         `json:"agents,omitempty" yaml:"agents,omitempty"`
	Channels  ChannelsConfig  `json:"channels" yaml:"channels"`
}

// SystemConfig holds system-wide settings.
type SystemConfig struct {
	ListenAddress string        `json:"listen_address" yaml:"listen_address"`
	DataDir       string        `json:"data_dir" yaml:"data_dir"`
	WorkspaceRoot string        `json:"workspace_root" yaml:"workspace_root"`
	LogLevel      string        `json:"log_level" yaml:"log_level"`
	LogArchive    ArchiveConfig `json:"log_archive" yaml:"log_archive"`
}

// ArchiveConfig holds log archive settings.
type ArchiveConfig struct {
	Enabled      bool   `json:"enabled" yaml:"enabled"`
	MaxEntries   int    `json:"max_entries" yaml:"max_entries"`
	KeepCopies   int    `json:"keep_copies" yaml:"keep_copies"`
	ArchiveDir   string `json:"archive_dir" yaml:"archive_dir"`
}

// AssistantConfig holds main assistant settings.
type AssistantConfig struct {
	Name           string `json:"name" yaml:"name"`
	AID            string `json:"aid" yaml:"aid"`
	RoleFile       string `json:"role_file,omitempty" yaml:"role_file,omitempty"`
	PromptFile     string `json:"prompt_file,omitempty" yaml:"prompt_file,omitempty"`
	Provider       string `json:"provider" yaml:"provider"`
	ModelTier      string `json:"model_tier" yaml:"model_tier"`
	MaxTurns       int    `json:"max_turns" yaml:"max_turns"`
	TimeoutMinutes int    `json:"timeout_minutes" yaml:"timeout_minutes"`
}

// ChannelsConfig holds messaging channel settings.
type ChannelsConfig struct {
	Discord  ChannelConfig `json:"discord" yaml:"discord"`
	WhatsApp ChannelConfig `json:"whatsapp" yaml:"whatsapp"`
}

// ChannelConfig holds settings for a single channel.
type ChannelConfig struct {
	Enabled bool   `json:"enabled" yaml:"enabled"`
	Token   string `json:"token,omitempty" yaml:"token,omitempty"`
}

// OrgChart provides hierarchy query operations on the agent/team structure.
type OrgChart interface {
	GetOrgChart() map[string]*Team
	GetAgentByAID(aid string) (*Agent, error)
	GetTeamBySlug(slug string) (*Team, error)
	GetTeamForAgent(aid string) (*Team, error)
	GetLeadTeams(aid string) ([]string, error)
	GetSubordinates(aid string) ([]Agent, error)
	GetSupervisor(aid string) (*Agent, error)
	RebuildFromConfig(master *MasterConfig, teams map[string]*Team) error
}

// GoOrchestrator manages task dispatch and routing between Go and containers.
type GoOrchestrator interface {
	DispatchTask(ctx context.Context, task *Task) error
	CancelTask(ctx context.Context, taskID string) error
	HandleTaskResult(result *TaskResult) error
	RouteMessage(ctx context.Context, jid string, content string) error
}

// WSHub manages WebSocket connections to containers.
type WSHub interface {
	RegisterConnection(teamID string, conn WSConnection) error
	UnregisterConnection(teamID string)
	SendToTeam(teamID string, msg []byte) error
	BroadcastAll(msg []byte) error
	GenerateToken(teamID string) (string, error)
	HandleUpgrade(w http.ResponseWriter, r *http.Request)
	GetConnectedTeams() []string
	SetOnMessage(handler func(teamID string, msg []byte))
}

// WSConnection represents a single WebSocket connection.
type WSConnection interface {
	Send(msg []byte) error
	Close() error
	TeamID() string
}

// ContainerRuntime provides low-level Docker container operations.
type ContainerRuntime interface {
	CreateContainer(ctx context.Context, config ContainerConfig) (string, error)
	StartContainer(ctx context.Context, containerID string) error
	StopContainer(ctx context.Context, containerID string, timeout time.Duration) error
	RemoveContainer(ctx context.Context, containerID string) error
	InspectContainer(ctx context.Context, containerID string) (*ContainerInfo, error)
	ListContainers(ctx context.Context) ([]ContainerInfo, error)
}

// ContainerInfo holds information about a running container.
type ContainerInfo struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	State ContainerState `json:"state"`
}

// ContainerManager provides higher-level container lifecycle management.
type ContainerManager interface {
	EnsureRunning(ctx context.Context, teamSlug string) error
	StopTeam(ctx context.Context, teamSlug string) error
	Cleanup(ctx context.Context) error
	GetStatus(teamSlug string) (ContainerState, error)
}

// HeartbeatMonitor tracks container health via heartbeat messages.
type HeartbeatMonitor interface {
	ProcessHeartbeat(teamID string, agents []AgentHeartbeatStatus)
	GetStatus(teamID string) (*HeartbeatStatus, error)
	StartMonitoring()
	StopMonitoring()
}

// AgentHeartbeatStatus represents agent status in a heartbeat.
type AgentHeartbeatStatus struct {
	AID            string          `json:"aid"`
	Status         AgentStatusType `json:"status"`
	Detail         string          `json:"detail"`
	ElapsedSeconds float64         `json:"elapsed_seconds"`
	MemoryMB       float64         `json:"memory_mb"`
}

// HeartbeatStatus holds the latest heartbeat information for a team.
type HeartbeatStatus struct {
	TeamID     string                 `json:"team_id"`
	Agents     []AgentHeartbeatStatus `json:"agents"`
	LastSeen   time.Time              `json:"last_seen"`
	IsHealthy  bool                   `json:"is_healthy"`
}

// SDKToolHandler handles SDK custom tool calls forwarded from containers.
type SDKToolHandler interface {
	HandleToolCall(callID string, toolName string, args json.RawMessage) (json.RawMessage, error)
}

// ChannelAdapter provides a messaging channel interface.
type ChannelAdapter interface {
	Connect() error
	Disconnect() error
	SendMessage(jid string, content string) error
	GetJIDPrefix() string
	IsConnected() bool
	OnMessage(callback func(jid string, content string))
	OnMetadata(callback func(jid string, metadata map[string]string))
}

// MessageRouter connects messaging channels to the orchestrator.
type MessageRouter interface {
	RegisterChannel(adapter ChannelAdapter) error
	UnregisterChannel(prefix string) error
	RouteInbound(jid string, content string) error
	RouteOutbound(jid string, content string) error
	GetChannels() map[string]bool
}

// EventBus provides publish/subscribe functionality for system events.
type EventBus interface {
	Publish(event Event)
	Subscribe(eventType EventType, handler func(Event)) string
	Unsubscribe(id string)
}

// KeyManager handles API key encryption and decryption.
type KeyManager interface {
	Encrypt(plaintext string) (string, error)
	Decrypt(ciphertext string) (string, error)
	IsLocked() bool
	Unlock(masterKey string) error
	Lock()
}

// TaskStore provides persistence for tasks.
type TaskStore interface {
	Create(ctx context.Context, task *Task) error
	Get(ctx context.Context, id string) (*Task, error)
	Update(ctx context.Context, task *Task) error
	Delete(ctx context.Context, id string) error
	ListByTeam(ctx context.Context, teamSlug string) ([]*Task, error)
	ListByStatus(ctx context.Context, status TaskStatus) ([]*Task, error)
	GetSubtree(ctx context.Context, rootID string) ([]*Task, error)
}

// MessageStore provides persistence for chat messages.
type MessageStore interface {
	Create(ctx context.Context, msg *Message) error
	GetByChat(ctx context.Context, chatJID string, since time.Time, limit int) ([]*Message, error)
	GetLatest(ctx context.Context, chatJID string, n int) ([]*Message, error)
	DeleteByChat(ctx context.Context, chatJID string) error
}

// LogStore provides persistence for log entries.
type LogStore interface {
	Create(ctx context.Context, entries []*LogEntry) error
	Query(ctx context.Context, opts LogQueryOpts) ([]*LogEntry, error)
	DeleteBefore(ctx context.Context, before time.Time) (int64, error)
	Count(ctx context.Context) (int64, error)
	GetOldest(ctx context.Context, limit int) ([]*LogEntry, error)
}

// LogQueryOpts defines query parameters for log retrieval.
type LogQueryOpts struct {
	Level     *LogLevel  `json:"level,omitempty"`
	Component string     `json:"component,omitempty"`
	Since     *time.Time `json:"since,omitempty"`
	Until     *time.Time `json:"until,omitempty"`
	Limit     int        `json:"limit,omitempty"`
	Offset    int        `json:"offset,omitempty"`
}

// SessionStore provides persistence for chat sessions.
type SessionStore interface {
	Get(ctx context.Context, chatJID string) (*ChatSession, error)
	Upsert(ctx context.Context, session *ChatSession) error
	Delete(ctx context.Context, chatJID string) error
	ListAll(ctx context.Context) ([]*ChatSession, error)
}
