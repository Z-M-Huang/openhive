package domain

import "fmt"

// TaskStatus represents the lifecycle state of a task.
type TaskStatus int

const (
	TaskStatusPending   TaskStatus = iota
	TaskStatusRunning
	TaskStatusCompleted
	TaskStatusFailed
	TaskStatusCancelled
)

var taskStatusNames = map[TaskStatus]string{
	TaskStatusPending:   "pending",
	TaskStatusRunning:   "running",
	TaskStatusCompleted: "completed",
	TaskStatusFailed:    "failed",
	TaskStatusCancelled: "cancelled",
}

var taskStatusValues = map[string]TaskStatus{
	"pending":   TaskStatusPending,
	"running":   TaskStatusRunning,
	"completed": TaskStatusCompleted,
	"failed":    TaskStatusFailed,
	"cancelled": TaskStatusCancelled,
}

func (s TaskStatus) String() string {
	if name, ok := taskStatusNames[s]; ok {
		return name
	}
	return fmt.Sprintf("TaskStatus(%d)", s)
}

// Validate returns an error if the TaskStatus is not a known value.
func (s TaskStatus) Validate() error {
	if _, ok := taskStatusNames[s]; !ok {
		return fmt.Errorf("invalid task status: %d", s)
	}
	return nil
}

// ParseTaskStatus converts a string to a TaskStatus.
func ParseTaskStatus(s string) (TaskStatus, error) {
	if v, ok := taskStatusValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid task status: %q", s)
}

// EventType represents the type of an event.
type EventType int

const (
	EventTypeTaskCreated    EventType = iota
	EventTypeTaskUpdated
	EventTypeTaskCompleted
	EventTypeTaskFailed
	EventTypeConfigChanged
	EventTypeTeamCreated
	EventTypeTeamDeleted
	EventTypeAgentStarted
	EventTypeAgentStopped
	EventTypeChannelMessage
)

var eventTypeNames = map[EventType]string{
	EventTypeTaskCreated:    "task_created",
	EventTypeTaskUpdated:    "task_updated",
	EventTypeTaskCompleted:  "task_completed",
	EventTypeTaskFailed:     "task_failed",
	EventTypeConfigChanged:  "config_changed",
	EventTypeTeamCreated:    "team_created",
	EventTypeTeamDeleted:    "team_deleted",
	EventTypeAgentStarted:   "agent_started",
	EventTypeAgentStopped:   "agent_stopped",
	EventTypeChannelMessage: "channel_message",
}

var eventTypeValues = map[string]EventType{
	"task_created":    EventTypeTaskCreated,
	"task_updated":    EventTypeTaskUpdated,
	"task_completed":  EventTypeTaskCompleted,
	"task_failed":     EventTypeTaskFailed,
	"config_changed":  EventTypeConfigChanged,
	"team_created":    EventTypeTeamCreated,
	"team_deleted":    EventTypeTeamDeleted,
	"agent_started":   EventTypeAgentStarted,
	"agent_stopped":   EventTypeAgentStopped,
	"channel_message": EventTypeChannelMessage,
}

func (e EventType) String() string {
	if name, ok := eventTypeNames[e]; ok {
		return name
	}
	return fmt.Sprintf("EventType(%d)", e)
}

// Validate returns an error if the EventType is not a known value.
func (e EventType) Validate() error {
	if _, ok := eventTypeNames[e]; !ok {
		return fmt.Errorf("invalid event type: %d", e)
	}
	return nil
}

// ParseEventType converts a string to an EventType.
func ParseEventType(s string) (EventType, error) {
	if v, ok := eventTypeValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid event type: %q", s)
}

// ProviderType represents the type of AI provider.
type ProviderType int

const (
	ProviderTypeOAuth          ProviderType = iota
	ProviderTypeAnthropicDirect
)

var providerTypeNames = map[ProviderType]string{
	ProviderTypeOAuth:           "oauth",
	ProviderTypeAnthropicDirect: "anthropic_direct",
}

var providerTypeValues = map[string]ProviderType{
	"oauth":            ProviderTypeOAuth,
	"anthropic_direct": ProviderTypeAnthropicDirect,
}

func (p ProviderType) String() string {
	if name, ok := providerTypeNames[p]; ok {
		return name
	}
	return fmt.Sprintf("ProviderType(%d)", p)
}

// Validate returns an error if the ProviderType is not a known value.
func (p ProviderType) Validate() error {
	if _, ok := providerTypeNames[p]; !ok {
		return fmt.Errorf("invalid provider type: %d", p)
	}
	return nil
}

// ParseProviderType converts a string to a ProviderType.
func ParseProviderType(s string) (ProviderType, error) {
	if v, ok := providerTypeValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid provider type: %q", s)
}

// LogLevel represents a logging severity level.
type LogLevel int

const (
	LogLevelDebug LogLevel = iota
	LogLevelInfo
	LogLevelWarn
	LogLevelError
)

var logLevelNames = map[LogLevel]string{
	LogLevelDebug: "debug",
	LogLevelInfo:  "info",
	LogLevelWarn:  "warn",
	LogLevelError: "error",
}

var logLevelValues = map[string]LogLevel{
	"debug": LogLevelDebug,
	"info":  LogLevelInfo,
	"warn":  LogLevelWarn,
	"error": LogLevelError,
}

func (l LogLevel) String() string {
	if name, ok := logLevelNames[l]; ok {
		return name
	}
	return fmt.Sprintf("LogLevel(%d)", l)
}

// Validate returns an error if the LogLevel is not a known value.
func (l LogLevel) Validate() error {
	if _, ok := logLevelNames[l]; !ok {
		return fmt.Errorf("invalid log level: %d", l)
	}
	return nil
}

// ParseLogLevel converts a string to a LogLevel.
func ParseLogLevel(s string) (LogLevel, error) {
	if v, ok := logLevelValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid log level: %q", s)
}

// ContainerState represents the state of a Docker container.
type ContainerState int

const (
	ContainerStateCreated  ContainerState = iota
	ContainerStateStarting
	ContainerStateRunning
	ContainerStateStopping
	ContainerStateStopped
	ContainerStateError
)

var containerStateNames = map[ContainerState]string{
	ContainerStateCreated:  "created",
	ContainerStateStarting: "starting",
	ContainerStateRunning:  "running",
	ContainerStateStopping: "stopping",
	ContainerStateStopped:  "stopped",
	ContainerStateError:    "error",
}

var containerStateValues = map[string]ContainerState{
	"created":  ContainerStateCreated,
	"starting": ContainerStateStarting,
	"running":  ContainerStateRunning,
	"stopping": ContainerStateStopping,
	"stopped":  ContainerStateStopped,
	"error":    ContainerStateError,
}

func (c ContainerState) String() string {
	if name, ok := containerStateNames[c]; ok {
		return name
	}
	return fmt.Sprintf("ContainerState(%d)", c)
}

// Validate returns an error if the ContainerState is not a known value.
func (c ContainerState) Validate() error {
	if _, ok := containerStateNames[c]; !ok {
		return fmt.Errorf("invalid container state: %d", c)
	}
	return nil
}

// ParseContainerState converts a string to a ContainerState.
func ParseContainerState(s string) (ContainerState, error) {
	if v, ok := containerStateValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid container state: %q", s)
}

// ModelTier represents the model capability tier.
type ModelTier int

const (
	ModelTierHaiku  ModelTier = iota
	ModelTierSonnet
	ModelTierOpus
)

var modelTierNames = map[ModelTier]string{
	ModelTierHaiku:  "haiku",
	ModelTierSonnet: "sonnet",
	ModelTierOpus:   "opus",
}

var modelTierValues = map[string]ModelTier{
	"haiku":  ModelTierHaiku,
	"sonnet": ModelTierSonnet,
	"opus":   ModelTierOpus,
}

func (m ModelTier) String() string {
	if name, ok := modelTierNames[m]; ok {
		return name
	}
	return fmt.Sprintf("ModelTier(%d)", m)
}

// Validate returns an error if the ModelTier is not a known value.
func (m ModelTier) Validate() error {
	if _, ok := modelTierNames[m]; !ok {
		return fmt.Errorf("invalid model tier: %d", m)
	}
	return nil
}

// ParseModelTier converts a string to a ModelTier.
func ParseModelTier(s string) (ModelTier, error) {
	if v, ok := modelTierValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid model tier: %q", s)
}

// AgentStatusType represents the runtime status of an agent.
type AgentStatusType int

const (
	AgentStatusIdle     AgentStatusType = iota
	AgentStatusBusy
	AgentStatusStarting
	AgentStatusStopped
	AgentStatusError
)

var agentStatusTypeNames = map[AgentStatusType]string{
	AgentStatusIdle:     "idle",
	AgentStatusBusy:     "busy",
	AgentStatusStarting: "starting",
	AgentStatusStopped:  "stopped",
	AgentStatusError:    "error",
}

var agentStatusTypeValues = map[string]AgentStatusType{
	"idle":     AgentStatusIdle,
	"busy":     AgentStatusBusy,
	"starting": AgentStatusStarting,
	"stopped":  AgentStatusStopped,
	"error":    AgentStatusError,
}

func (a AgentStatusType) String() string {
	if name, ok := agentStatusTypeNames[a]; ok {
		return name
	}
	return fmt.Sprintf("AgentStatusType(%d)", a)
}

// Validate returns an error if the AgentStatusType is not a known value.
func (a AgentStatusType) Validate() error {
	if _, ok := agentStatusTypeNames[a]; !ok {
		return fmt.Errorf("invalid agent status type: %d", a)
	}
	return nil
}

// ParseAgentStatusType converts a string to an AgentStatusType.
func ParseAgentStatusType(s string) (AgentStatusType, error) {
	if v, ok := agentStatusTypeValues[s]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("invalid agent status type: %q", s)
}
