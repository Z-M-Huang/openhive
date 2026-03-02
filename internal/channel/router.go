package channel

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/google/uuid"
)

// Router implements domain.MessageRouter, connecting messaging channels to the
// main assistant via WebSocket. Inbound messages create Tasks and dispatch them
// via WSHub. Task results are routed back to the originating channel.
type Router struct {
	channels           map[string]domain.ChannelAdapter
	wsHub              domain.WSHub
	taskStore          domain.TaskStore
	sessionStore       domain.SessionStore
	logger             *slog.Logger
	mu                 sync.RWMutex
	mainTeamID         string
	mainAssistantAID   string
}

// RouterConfig holds configuration for the message router.
type RouterConfig struct {
	WSHub              domain.WSHub
	TaskStore          domain.TaskStore
	SessionStore       domain.SessionStore
	Logger             *slog.Logger
	MainTeamID         string
	MainAssistantAID   string
}

// NewRouter creates a new message router.
func NewRouter(cfg RouterConfig) *Router {
	return &Router{
		channels:           make(map[string]domain.ChannelAdapter),
		wsHub:              cfg.WSHub,
		taskStore:          cfg.TaskStore,
		sessionStore:       cfg.SessionStore,
		logger:             cfg.Logger,
		mainTeamID:         cfg.MainTeamID,
		mainAssistantAID:   cfg.MainAssistantAID,
	}
}

// RegisterChannel registers a channel adapter, keyed by its JID prefix.
func (r *Router) RegisterChannel(adapter domain.ChannelAdapter) error {
	prefix := adapter.GetJIDPrefix()
	if prefix == "" {
		return &domain.ValidationError{Field: "prefix", Message: "channel prefix must not be empty"}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.channels[prefix]; exists {
		return &domain.ConflictError{
			Resource: "channel",
			Message:  fmt.Sprintf("channel with prefix %q is already registered", prefix),
		}
	}

	// Wire up the onMessage callback
	adapter.OnMessage(func(jid string, content string) {
		if err := r.RouteInbound(jid, content); err != nil {
			r.logger.Error("failed to route inbound message", "jid", jid, "error", err)
		}
	})

	r.channels[prefix] = adapter
	r.logger.Info("channel registered", "prefix", prefix)
	return nil
}

// UnregisterChannel removes a channel adapter by its prefix.
func (r *Router) UnregisterChannel(prefix string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.channels[prefix]; !exists {
		return &domain.NotFoundError{Resource: "channel", ID: prefix}
	}

	delete(r.channels, prefix)
	r.logger.Info("channel unregistered", "prefix", prefix)
	return nil
}

// RouteInbound handles an incoming message from a channel. Creates a Task,
// persists it, and dispatches to the main assistant container via WebSocket.
func (r *Router) RouteInbound(jid string, content string) error {
	ctx := context.Background()

	// Get or create session
	session, err := r.getOrCreateSession(ctx, jid)
	if err != nil {
		return fmt.Errorf("session error: %w", err)
	}

	// Format message for the agent
	channelType := extractPrefix(jid)
	formatted := FormatUserMessage(channelType, jid, content)

	// Create task
	taskID := uuid.NewString()
	now := time.Now()
	task := &domain.Task{
		ID:        taskID,
		TeamSlug:  "main",
		AgentAID:  session.AgentAID,
		Status:    domain.TaskStatusPending,
		Prompt:    formatted,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := r.taskStore.Create(ctx, task); err != nil {
		return fmt.Errorf("failed to create task: %w", err)
	}

	// Update session timestamp
	session.LastTimestamp = now
	if err := r.sessionStore.Upsert(ctx, session); err != nil {
		r.logger.Warn("failed to update session", "jid", jid, "error", err)
	}

	// Dispatch via WebSocket
	dispatchMsg := ws.TaskDispatchMsg{
		TaskID:    taskID,
		AgentAID:  session.AgentAID,
		Prompt:    formatted,
		SessionID: session.SessionID,
	}

	encoded, err := ws.EncodeMessage(ws.MsgTypeTaskDispatch, dispatchMsg)
	if err != nil {
		return fmt.Errorf("failed to encode task dispatch: %w", err)
	}

	if err := r.wsHub.SendToTeam(r.mainTeamID, encoded); err != nil {
		r.logger.Warn("failed to send task dispatch (container may not be connected)", "team_id", r.mainTeamID, "error", err)
		// Don't return error - the task is persisted and can be retried
	}

	r.logger.Info("message routed inbound",
		"jid", jid,
		"task_id", taskID,
		"channel", channelType,
	)

	return nil
}

// RouteOutbound sends a response to the correct channel based on JID prefix.
func (r *Router) RouteOutbound(jid string, content string) error {
	r.logger.Debug("routing outbound", "jid", jid, "content_len", len(content))
	prefix := extractPrefix(jid)

	r.mu.RLock()
	adapter, exists := r.channels[prefix]
	r.mu.RUnlock()

	if !exists {
		return &domain.NotFoundError{Resource: "channel", ID: prefix}
	}

	// Strip any XML wrapper tags from agent response
	cleaned := StripResponseTags(content)

	if err := adapter.SendMessage(jid, cleaned); err != nil {
		return fmt.Errorf("failed to send message to channel %s: %w", prefix, err)
	}

	r.logger.Info("message routed outbound", "jid", jid, "channel", prefix)
	return nil
}

// GetChannels returns a map of registered channel prefixes to their connection status.
func (r *Router) GetChannels() map[string]bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make(map[string]bool, len(r.channels))
	for prefix, adapter := range r.channels {
		result[prefix] = adapter.IsConnected()
	}
	return result
}

// HandleTaskResult processes a task result received from a container.
// Updates the task in the DB and routes the response to the originating channel.
func (r *Router) HandleTaskResult(ctx context.Context, result *ws.TaskResultMsg) error {
	r.logger.Debug("handling task result",
		"task_id", result.TaskID,
		"status", result.Status,
		"has_result", result.Result != "",
		"has_error", result.Error != "",
	)

	// Update task in DB
	task, err := r.taskStore.Get(ctx, result.TaskID)
	if err != nil {
		return fmt.Errorf("task not found: %w", err)
	}

	now := time.Now()
	task.UpdatedAt = now
	task.CompletedAt = &now

	if result.Status == "completed" {
		task.Status = domain.TaskStatusCompleted
		task.Result = result.Result
	} else {
		task.Status = domain.TaskStatusFailed
		task.Error = result.Error
	}

	if err := r.taskStore.Update(ctx, task); err != nil {
		r.logger.Error("failed to update task", "task_id", result.TaskID, "error", err)
	}

	// Update session with agent's response timestamp and session ID
	session, sessionErr := r.sessionStore.Get(ctx, sessionJIDForTask(task))
	if sessionErr == nil {
		session.LastAgentTimestamp = now
		if err := r.sessionStore.Upsert(ctx, session); err != nil {
			r.logger.Warn("failed to update session after result", "error", err)
		}
	}

	// Route response to the originating channel
	jid := sessionJIDForTask(task)
	if jid != "" {
		var content string
		if result.Status == "completed" && result.Result != "" {
			content = result.Result
		} else if result.Status == "failed" {
			// Log the internal error for debugging but never expose it to the user.
			r.logger.Error("task failed", "task_id", result.TaskID, "internal_error", result.Error)
			content = "Sorry, I encountered an issue processing your request. Please try again."
		}
		if content != "" {
			if routeErr := r.RouteOutbound(jid, content); routeErr != nil {
				r.logger.Error("failed to route response", "task_id", result.TaskID, "error", routeErr)
				return routeErr
			}
		}
	}

	return nil
}

func (r *Router) getOrCreateSession(ctx context.Context, jid string) (*domain.ChatSession, error) {
	session, err := r.sessionStore.Get(ctx, jid)
	if err != nil {
		// Create new session with main assistant as the default agent
		session = &domain.ChatSession{
			ChatJID:     jid,
			ChannelType: extractPrefix(jid),
			AgentAID:    r.mainAssistantAID,
		}
		if err := r.sessionStore.Upsert(ctx, session); err != nil {
			return nil, fmt.Errorf("failed to create session: %w", err)
		}
	}
	return session, nil
}

// FormatUserMessage wraps user content in XML tags for agent consumption.
func FormatUserMessage(channelType, jid, content string) string {
	return fmt.Sprintf(`<user_message channel=%q jid=%q>%s</user_message>`, channelType, jid, content)
}

// StripResponseTags removes XML wrapper tags from agent responses.
func StripResponseTags(content string) string {
	// Remove <agent_response ...> wrapper if present
	if idx := strings.Index(content, ">"); idx != -1 && strings.HasPrefix(content, "<agent_response") {
		content = content[idx+1:]
		if endIdx := strings.LastIndex(content, "</agent_response>"); endIdx != -1 {
			content = content[:endIdx]
		}
	}
	return strings.TrimSpace(content)
}

// extractPrefix gets the channel prefix from a JID (everything before the first colon).
func extractPrefix(jid string) string {
	if idx := strings.Index(jid, ":"); idx != -1 {
		return jid[:idx]
	}
	return jid
}

// sessionJIDForTask extracts the originating JID for a task.
// For now, tasks created through the router are associated with a chat JID
// via the prompt's XML attributes.
func sessionJIDForTask(task *domain.Task) string {
	// Extract jid from <user_message ... jid="..."> tag
	const jidPrefix = `jid="`
	idx := strings.Index(task.Prompt, jidPrefix)
	if idx == -1 {
		return ""
	}
	start := idx + len(jidPrefix)
	end := strings.Index(task.Prompt[start:], `"`)
	if end == -1 {
		return ""
	}
	return task.Prompt[start : start+end]
}
