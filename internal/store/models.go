package store

import (
	"encoding/json"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// TaskModel is the GORM model for tasks.
type TaskModel struct {
	ID          string     `gorm:"primaryKey;column:id"`
	ParentID    string     `gorm:"column:parent_id;index"`
	TeamSlug    string     `gorm:"column:team_slug;index"`
	AgentAID    string     `gorm:"column:agent_aid;index"`
	Status      int        `gorm:"column:status;index"`
	Prompt      string     `gorm:"column:prompt"`
	Result      string     `gorm:"column:result"`
	Error       string     `gorm:"column:error"`
	CreatedAt   time.Time  `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt   time.Time  `gorm:"column:updated_at;autoUpdateTime"`
	CompletedAt *time.Time `gorm:"column:completed_at"`
}

// TableName returns the table name for TaskModel.
func (TaskModel) TableName() string { return "tasks" }

// ToDomain converts a TaskModel to a domain Task.
func (m *TaskModel) ToDomain() *domain.Task {
	return &domain.Task{
		ID:          m.ID,
		ParentID:    m.ParentID,
		TeamSlug:    m.TeamSlug,
		AgentAID:    m.AgentAID,
		Status:      domain.TaskStatus(m.Status),
		Prompt:      m.Prompt,
		Result:      m.Result,
		Error:       m.Error,
		CreatedAt:   m.CreatedAt,
		UpdatedAt:   m.UpdatedAt,
		CompletedAt: m.CompletedAt,
	}
}

// TaskModelFromDomain creates a TaskModel from a domain Task.
func TaskModelFromDomain(t *domain.Task) *TaskModel {
	return &TaskModel{
		ID:          t.ID,
		ParentID:    t.ParentID,
		TeamSlug:    t.TeamSlug,
		AgentAID:    t.AgentAID,
		Status:      int(t.Status),
		Prompt:      t.Prompt,
		Result:      t.Result,
		Error:       t.Error,
		CreatedAt:   t.CreatedAt,
		UpdatedAt:   t.UpdatedAt,
		CompletedAt: t.CompletedAt,
	}
}

// MessageModel is the GORM model for messages.
type MessageModel struct {
	ID        string    `gorm:"primaryKey;column:id"`
	ChatJID   string    `gorm:"column:chat_jid;index"`
	Role      string    `gorm:"column:role"`
	Content   string    `gorm:"column:content"`
	Timestamp time.Time `gorm:"column:timestamp;index"`
}

// TableName returns the table name for MessageModel.
func (MessageModel) TableName() string { return "messages" }

// ToDomain converts a MessageModel to a domain Message.
func (m *MessageModel) ToDomain() *domain.Message {
	return &domain.Message{
		ID:        m.ID,
		ChatJID:   m.ChatJID,
		Role:      m.Role,
		Content:   m.Content,
		Timestamp: m.Timestamp,
	}
}

// MessageModelFromDomain creates a MessageModel from a domain Message.
func MessageModelFromDomain(msg *domain.Message) *MessageModel {
	return &MessageModel{
		ID:        msg.ID,
		ChatJID:   msg.ChatJID,
		Role:      msg.Role,
		Content:   msg.Content,
		Timestamp: msg.Timestamp,
	}
}

// LogEntryModel is the GORM model for log entries.
type LogEntryModel struct {
	ID         uint      `gorm:"primaryKey;autoIncrement;column:id"`
	Level      int       `gorm:"column:level;index"`
	Component  string    `gorm:"column:component;index"`
	Action     string    `gorm:"column:action"`
	Message    string    `gorm:"column:message"`
	Params     string    `gorm:"column:params;type:text"`
	TeamName   string    `gorm:"column:team_name;index"`
	TaskID     string    `gorm:"column:task_id;index"`
	AgentName  string    `gorm:"column:agent_name"`
	RequestID  string    `gorm:"column:request_id;index"`
	Error      string    `gorm:"column:error"`
	DurationMs int64     `gorm:"column:duration_ms"`
	CreatedAt  time.Time `gorm:"column:created_at;index;autoCreateTime"`
}

// TableName returns the table name for LogEntryModel.
func (LogEntryModel) TableName() string { return "log_entries" }

// ToDomain converts a LogEntryModel to a domain LogEntry.
func (m *LogEntryModel) ToDomain() *domain.LogEntry {
	var params json.RawMessage
	if m.Params != "" {
		params = json.RawMessage(m.Params)
	}
	return &domain.LogEntry{
		ID:         m.ID,
		Level:      domain.LogLevel(m.Level),
		Component:  m.Component,
		Action:     m.Action,
		Message:    m.Message,
		Params:     params,
		TeamName:   m.TeamName,
		TaskID:     m.TaskID,
		AgentName:  m.AgentName,
		RequestID:  m.RequestID,
		Error:      m.Error,
		DurationMs: m.DurationMs,
		CreatedAt:  m.CreatedAt,
	}
}

// LogEntryModelFromDomain creates a LogEntryModel from a domain LogEntry.
func LogEntryModelFromDomain(e *domain.LogEntry) *LogEntryModel {
	params := ""
	if e.Params != nil {
		params = string(e.Params)
	}
	return &LogEntryModel{
		ID:         e.ID,
		Level:      int(e.Level),
		Component:  e.Component,
		Action:     e.Action,
		Message:    e.Message,
		Params:     params,
		TeamName:   e.TeamName,
		TaskID:     e.TaskID,
		AgentName:  e.AgentName,
		RequestID:  e.RequestID,
		Error:      e.Error,
		DurationMs: e.DurationMs,
		CreatedAt:  e.CreatedAt,
	}
}

// ChatSessionModel is the GORM model for chat sessions.
type ChatSessionModel struct {
	ChatJID           string    `gorm:"primaryKey;column:chat_jid"`
	ChannelType       string    `gorm:"column:channel_type"`
	LastTimestamp      time.Time `gorm:"column:last_timestamp"`
	LastAgentTimestamp time.Time `gorm:"column:last_agent_timestamp"`
	SessionID         string    `gorm:"column:session_id"`
	AgentAID          string    `gorm:"column:agent_aid"`
}

// TableName returns the table name for ChatSessionModel.
func (ChatSessionModel) TableName() string { return "chat_sessions" }

// ToDomain converts a ChatSessionModel to a domain ChatSession.
func (m *ChatSessionModel) ToDomain() *domain.ChatSession {
	return &domain.ChatSession{
		ChatJID:           m.ChatJID,
		ChannelType:       m.ChannelType,
		LastTimestamp:      m.LastTimestamp,
		LastAgentTimestamp: m.LastAgentTimestamp,
		SessionID:         m.SessionID,
		AgentAID:          m.AgentAID,
	}
}

// ChatSessionModelFromDomain creates a ChatSessionModel from a domain ChatSession.
func ChatSessionModelFromDomain(s *domain.ChatSession) *ChatSessionModel {
	return &ChatSessionModel{
		ChatJID:           s.ChatJID,
		ChannelType:       s.ChannelType,
		LastTimestamp:      s.LastTimestamp,
		LastAgentTimestamp: s.LastAgentTimestamp,
		SessionID:         s.SessionID,
		AgentAID:          s.AgentAID,
	}
}
