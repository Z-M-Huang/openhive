package store

import (
	"context"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SessionStoreImpl implements domain.SessionStore using GORM.
type SessionStoreImpl struct {
	db *DB
}

// NewSessionStore creates a new SessionStore.
func NewSessionStore(db *DB) *SessionStoreImpl {
	return &SessionStoreImpl{db: db}
}

// Get retrieves a chat session by JID.
func (s *SessionStoreImpl) Get(_ context.Context, chatJID string) (*domain.ChatSession, error) {
	var model ChatSessionModel
	if err := s.db.Reader.Where("chat_jid = ?", chatJID).First(&model).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, &domain.NotFoundError{Resource: "session", ID: chatJID}
		}
		return nil, err
	}
	return model.ToDomain(), nil
}

// Upsert creates or updates a chat session.
func (s *SessionStoreImpl) Upsert(_ context.Context, session *domain.ChatSession) error {
	model := ChatSessionModelFromDomain(session)
	return s.db.Writer.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "chat_jid"}},
		DoUpdates: clause.AssignmentColumns([]string{"channel_type", "last_timestamp", "last_agent_timestamp", "session_id", "agent_aid"}),
	}).Create(model).Error
}

// UpsertWithTx creates or updates a chat session within the provided transaction.
func (s *SessionStoreImpl) UpsertWithTx(tx *gorm.DB, session *domain.ChatSession) error {
	model := ChatSessionModelFromDomain(session)
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "chat_jid"}},
		DoUpdates: clause.AssignmentColumns([]string{"channel_type", "last_timestamp", "last_agent_timestamp", "session_id", "agent_aid"}),
	}).Create(model).Error
}

// Delete removes a chat session.
func (s *SessionStoreImpl) Delete(_ context.Context, chatJID string) error {
	return s.db.Writer.Where("chat_jid = ?", chatJID).Delete(&ChatSessionModel{}).Error
}

// ListAll returns all chat sessions.
func (s *SessionStoreImpl) ListAll(_ context.Context) ([]*domain.ChatSession, error) {
	var models []ChatSessionModel
	if err := s.db.Reader.Find(&models).Error; err != nil {
		return nil, err
	}
	sessions := make([]*domain.ChatSession, len(models))
	for i := range models {
		sessions[i] = models[i].ToDomain()
	}
	return sessions, nil
}
