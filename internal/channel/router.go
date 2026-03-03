package channel

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const defaultMaxMessageLength = 10000

// Router implements domain.MessageRouter, connecting messaging channels to the
// main assistant via WebSocket. Inbound messages create Tasks and dispatch them
// via WSHub. Task results are routed back to the originating channel.
type Router struct {
	channels         map[string]domain.ChannelAdapter
	wsHub            domain.WSHub
	taskStore        domain.TaskStore
	sessionStore     domain.SessionStore
	messageStore     domain.MessageStore
	transactor       domain.Transactor
	logger           *slog.Logger
	mu               sync.RWMutex
	mainTeamID       string
	mainAssistantAID string
	maxMessageLength int
}

// RouterConfig holds configuration for the message router.
type RouterConfig struct {
	WSHub            domain.WSHub
	TaskStore        domain.TaskStore
	SessionStore     domain.SessionStore
	MessageStore     domain.MessageStore
	Transactor       domain.Transactor
	Logger           *slog.Logger
	MainTeamID       string
	MainAssistantAID string
	MaxMessageLength int
}

// NewRouter creates a new message router.
func NewRouter(cfg RouterConfig) *Router {
	maxLen := cfg.MaxMessageLength
	if maxLen <= 0 {
		maxLen = defaultMaxMessageLength
	}
	return &Router{
		channels:         make(map[string]domain.ChannelAdapter),
		wsHub:            cfg.WSHub,
		taskStore:        cfg.TaskStore,
		sessionStore:     cfg.SessionStore,
		messageStore:     cfg.MessageStore,
		transactor:       cfg.Transactor,
		logger:           cfg.Logger,
		mainTeamID:       cfg.MainTeamID,
		mainAssistantAID: cfg.MainAssistantAID,
		maxMessageLength: maxLen,
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
// It wraps task creation and session cursor update in a single transaction so
// that a crash mid-operation leaves no partial state.
func (r *Router) RouteInbound(jid string, content string) error {
	ctx := context.Background()

	// Enforce message length limit to prevent abuse.
	if len(content) > r.maxMessageLength {
		return &domain.ValidationError{
			Field:   "content",
			Message: fmt.Sprintf("message exceeds maximum length of %d characters", r.maxMessageLength),
		}
	}

	// Get or create session
	session, err := r.getOrCreateSession(ctx, jid)
	if err != nil {
		return fmt.Errorf("session error: %w", err)
	}

	// Escape content to prevent XML injection in the agent prompt.
	escapedContent := html.EscapeString(content)
	channelType := extractPrefix(jid)
	formatted := FormatUserMessage(channelType, escapedContent)

	// Create task
	taskID := uuid.NewString()
	now := time.Now()
	task := &domain.Task{
		ID:        taskID,
		TeamSlug:  "main",
		AgentAID:  session.AgentAID,
		JID:       jid,
		Status:    domain.TaskStatusPending,
		Prompt:    formatted,
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Wrap task creation + session cursor update in a transaction.
	// If either fails, both are rolled back.
	var persistErr error
	if r.transactor != nil {
		taskStoreWithTx, ok := r.taskStore.(*TaskStoreWithTx)
		sessionStoreWithTx, ok2 := r.sessionStore.(*SessionStoreWithTx)
		if ok && ok2 {
			persistErr = r.transactor.WithTransaction(func(tx *gorm.DB) error {
				if err := taskStoreWithTx.CreateWithTx(tx, task); err != nil {
					return fmt.Errorf("failed to create task in transaction: %w", err)
				}
				session.LastTimestamp = now
				if err := sessionStoreWithTx.UpsertWithTx(tx, session); err != nil {
					return fmt.Errorf("failed to update session in transaction: %w", err)
				}
				return nil
			})
		} else {
			// Fall back to non-transactional path if concrete types not available.
			// Log a warning because the task and session update are no longer atomic —
			// a crash between the two calls could leave partial state.
			r.logger.Warn("transactor set but stores do not implement WithTx; falling back to non-transactional path",
				"task_store_type", fmt.Sprintf("%T", r.taskStore),
				"session_store_type", fmt.Sprintf("%T", r.sessionStore),
			)
			persistErr = r.taskStore.Create(ctx, task)
			if persistErr == nil {
				session.LastTimestamp = now
				if err := r.sessionStore.Upsert(ctx, session); err != nil {
					r.logger.Warn("failed to update session in fallback path", "jid", jid, "error", err)
				}
			}
		}
	} else {
		persistErr = r.taskStore.Create(ctx, task)
		if persistErr == nil {
			session.LastTimestamp = now
			if err := r.sessionStore.Upsert(ctx, session); err != nil {
				r.logger.Warn("failed to update session", "jid", jid, "error", err)
			}
		}
	}
	if persistErr != nil {
		return fmt.Errorf("failed to persist task: %w", persistErr)
	}

	// Persist inbound message
	if r.messageStore != nil {
		msg := &domain.Message{
			ID:        uuid.NewString(),
			ChatJID:   jid,
			Role:      "user",
			Content:   content,
			Timestamp: now,
		}
		if err := r.messageStore.Create(ctx, msg); err != nil {
			r.logger.Warn("failed to persist inbound message", "jid", jid, "error", err)
		}
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

	// Update session with agent's response timestamp
	jid := task.JID
	if jid != "" {
		session, sessionErr := r.sessionStore.Get(ctx, jid)
		if sessionErr == nil {
			session.LastAgentTimestamp = now
			if err := r.sessionStore.Upsert(ctx, session); err != nil {
				r.logger.Warn("failed to update session after result", "error", err)
			}
		}

		// Persist outbound message
		if r.messageStore != nil {
			var content string
			if result.Status == "completed" {
				content = result.Result
			}
			if content != "" {
				msg := &domain.Message{
					ID:        uuid.NewString(),
					ChatJID:   jid,
					Role:      "assistant",
					Content:   content,
					Timestamp: now,
				}
				if err := r.messageStore.Create(ctx, msg); err != nil {
					r.logger.Warn("failed to persist outbound message", "task_id", result.TaskID, "error", err)
				}
			}
		}

		// Route response to the originating channel
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

// RecoverInFlight re-dispatches tasks that were in-flight when the server crashed.
// It detects these by comparing lastTimestamp > lastAgentTimestamp on sessions.
func (r *Router) RecoverInFlight(ctx context.Context) error {
	sessions, err := r.sessionStore.ListAll(ctx)
	if err != nil {
		return fmt.Errorf("failed to list sessions for recovery: %w", err)
	}

	recovered := 0
	for _, session := range sessions {
		if session.LastTimestamp.After(session.LastAgentTimestamp) {
			// This session has an in-flight message. Find the pending/running task.
			tasks, err := r.taskStore.ListByTeam(ctx, "main")
			if err != nil {
				r.logger.Warn("recovery: failed to list tasks", "jid", session.ChatJID, "error", err)
				continue
			}
			for _, task := range tasks {
				if task.JID == session.ChatJID &&
					(task.Status == domain.TaskStatusPending || task.Status == domain.TaskStatusRunning) {
					// Re-dispatch the task
					dispatchMsg := ws.TaskDispatchMsg{
						TaskID:    task.ID,
						AgentAID:  session.AgentAID,
						Prompt:    task.Prompt,
						SessionID: session.SessionID,
					}
					encoded, encErr := ws.EncodeMessage(ws.MsgTypeTaskDispatch, dispatchMsg)
					if encErr != nil {
						r.logger.Warn("recovery: failed to encode dispatch", "task_id", task.ID, "error", encErr)
						continue
					}
					if sendErr := r.wsHub.SendToTeam(r.mainTeamID, encoded); sendErr != nil {
						r.logger.Warn("recovery: failed to re-dispatch task", "task_id", task.ID, "error", sendErr)
					} else {
						r.logger.Info("recovery: re-dispatched in-flight task", "task_id", task.ID, "jid", session.ChatJID)
						recovered++
					}
					break
				}
			}
		}
	}

	if recovered > 0 {
		r.logger.Info("in-flight recovery complete", "recovered", recovered)
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

// FormatUserMessage wraps user content in a safe JSON-like format for agent consumption.
// Content is already HTML-escaped before being passed here.
func FormatUserMessage(channelType, escapedContent string) string {
	return fmt.Sprintf(`<user_message channel=%q>%s</user_message>`, channelType, escapedContent)
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

// TaskStoreWithTx extends a TaskStore with transactional write support.
// This avoids adding WithTx to the domain.TaskStore interface.
type TaskStoreWithTx struct {
	domain.TaskStore
	impl interface{ CreateWithTx(tx *gorm.DB, task *domain.Task) error }
}

// CreateWithTx delegates to the concrete implementation.
func (s *TaskStoreWithTx) CreateWithTx(tx *gorm.DB, task *domain.Task) error {
	return s.impl.CreateWithTx(tx, task)
}

// SessionStoreWithTx extends a SessionStore with transactional write support.
type SessionStoreWithTx struct {
	domain.SessionStore
	impl interface{ UpsertWithTx(tx *gorm.DB, session *domain.ChatSession) error }
}

// UpsertWithTx delegates to the concrete implementation.
func (s *SessionStoreWithTx) UpsertWithTx(tx *gorm.DB, session *domain.ChatSession) error {
	return s.impl.UpsertWithTx(tx, session)
}
