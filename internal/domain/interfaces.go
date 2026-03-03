package domain

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"gorm.io/gorm"
)

// ConfigLoader handles config file I/O and watching.
type ConfigLoader interface {
	LoadMaster() (*MasterConfig, error)
	SaveMaster(cfg *MasterConfig) error
	GetMaster() *MasterConfig
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
	ListenAddress          string         `json:"listen_address" yaml:"listen_address"`
	DataDir                string         `json:"data_dir" yaml:"data_dir"`
	WorkspaceRoot          string         `json:"workspace_root" yaml:"workspace_root"`
	LogLevel               string         `json:"log_level" yaml:"log_level"`
	LogArchive             ArchiveConfig  `json:"log_archive" yaml:"log_archive"`
	MaxMessageLength       int            `json:"max_message_length" yaml:"max_message_length"`
	DefaultIdleTimeout     string         `json:"default_idle_timeout" yaml:"default_idle_timeout"`
	EventBusWorkers        int            `json:"event_bus_workers" yaml:"event_bus_workers"`
	PortalWSMaxConnections int            `json:"portal_ws_max_connections" yaml:"portal_ws_max_connections"`
	MessageArchive         ArchiveConfig  `json:"message_archive" yaml:"message_archive"`
}

// MessageArchiveConfig is an alias for ArchiveConfig used for message archival settings.
// Kept as ArchiveConfig for consistency.

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
	Enabled   bool   `json:"enabled" yaml:"enabled"`
	Token     string `json:"token,omitempty" yaml:"token,omitempty"`
	ChannelID string `json:"channel_id,omitempty" yaml:"channel_id,omitempty"`
	StorePath string `json:"store_path,omitempty" yaml:"store_path,omitempty"`
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

// TODO: GoOrchestrator interface -- see wiki Architecture Decisions for design

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
	SetOnConnect(handler func(teamID string))
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
	ProvisionTeam(ctx context.Context, teamSlug string, secrets map[string]string) error
	RemoveTeam(ctx context.Context, teamSlug string) error
	RestartTeam(ctx context.Context, teamSlug string) error
	StopTeam(ctx context.Context, teamSlug string) error
	Cleanup(ctx context.Context) error
	GetStatus(teamSlug string) (ContainerState, error)
	GetContainerID(teamSlug string) (string, error)
}

// HeartbeatMonitor tracks container health via heartbeat messages.
type HeartbeatMonitor interface {
	ProcessHeartbeat(teamID string, agents []AgentHeartbeatStatus)
	GetStatus(teamID string) (*HeartbeatStatus, error)
	GetAllStatuses() map[string]*HeartbeatStatus
	SetOnUnhealthy(callback func(teamID string))
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
	HandleToolCallWithContext(teamID, callID, toolName, agentAID string, args json.RawMessage) (json.RawMessage, error)
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
	FilteredSubscribe(eventType EventType, filter func(Event) bool, handler func(Event)) string
	Unsubscribe(id string)
	Close()
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
	// DeleteBefore removes all messages older than the given cutoff time.
	// Returns the number of deleted rows.
	DeleteBefore(ctx context.Context, before time.Time) (int64, error)
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
	TeamName  string     `json:"team_name,omitempty"`
	AgentName string     `json:"agent_name,omitempty"`
	TaskID    string     `json:"task_id,omitempty"`
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

// Transactor provides database transaction support.
// The concrete implementation is provided by store.DB.
type Transactor interface {
	WithTransaction(fn func(tx *gorm.DB) error) error
}

// TeamProvisioner handles team lifecycle operations.
type TeamProvisioner interface {
	CreateTeam(ctx context.Context, slug string, leaderAID string) (*Team, error)
	DeleteTeam(ctx context.Context, slug string) error
	GetTeam(ctx context.Context, slug string) (*Team, error)
	ListTeams(ctx context.Context) ([]*Team, error)
	UpdateTeam(ctx context.Context, slug string, updates map[string]interface{}) (*Team, error)
}

// TaskCoordinator handles task dispatch and result tracking.
type TaskCoordinator interface {
	DispatchTask(ctx context.Context, task *Task) error
	HandleTaskResult(ctx context.Context, taskID string, result string, errMsg string) error
	CancelTask(ctx context.Context, taskID string) error
	GetTaskStatus(ctx context.Context, taskID string) (*Task, error)
	CreateSubtasks(ctx context.Context, parentID string, prompts []string, teamSlug string) ([]*Task, error)
}

// HealthManager handles container health monitoring.
type HealthManager interface {
	GetHealthStatus(teamSlug string) (*HeartbeatStatus, error)
	HandleUnhealthy(ctx context.Context, teamID string) error
	GetAllStatuses() map[string]*HeartbeatStatus
}

// GoOrchestrator is the composite orchestrator interface combining all sub-interfaces.
type GoOrchestrator interface {
	TeamProvisioner
	TaskCoordinator
	HealthManager
	Start(ctx context.Context) error
	Stop() error
}
