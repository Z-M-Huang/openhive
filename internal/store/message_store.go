package store

import (
	"context"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gorm.io/gorm"
)

// MessageStoreImpl implements domain.MessageStore using GORM.
type MessageStoreImpl struct {
	db *DB
}

// NewMessageStore creates a new MessageStore.
func NewMessageStore(db *DB) *MessageStoreImpl {
	return &MessageStoreImpl{db: db}
}

// Create inserts a new message into the database.
func (s *MessageStoreImpl) Create(_ context.Context, msg *domain.Message) error {
	model := MessageModelFromDomain(msg)
	return s.db.Writer.Create(model).Error
}

// GetByChat retrieves messages for a chat since a given time.
func (s *MessageStoreImpl) GetByChat(_ context.Context, chatJID string, since time.Time, limit int) ([]*domain.Message, error) {
	var models []MessageModel
	query := s.db.Reader.Where("chat_jid = ? AND timestamp >= ?", chatJID, since).Order("timestamp ASC")
	if limit > 0 {
		query = query.Limit(limit)
	}
	if err := query.Find(&models).Error; err != nil {
		return nil, err
	}
	return toMessageDomainSlice(models), nil
}

// GetLatest retrieves the N most recent messages for a chat.
func (s *MessageStoreImpl) GetLatest(_ context.Context, chatJID string, n int) ([]*domain.Message, error) {
	var models []MessageModel
	if err := s.db.Reader.Where("chat_jid = ?", chatJID).Order("timestamp DESC").Limit(n).Find(&models).Error; err != nil {
		return nil, err
	}
	// Reverse to chronological order
	for i, j := 0, len(models)-1; i < j; i, j = i+1, j-1 {
		models[i], models[j] = models[j], models[i]
	}
	return toMessageDomainSlice(models), nil
}

// DeleteByChat removes all messages for a chat.
func (s *MessageStoreImpl) DeleteByChat(_ context.Context, chatJID string) error {
	return s.db.Writer.Where("chat_jid = ?", chatJID).Delete(&MessageModel{}).Error
}

// GetByID retrieves a single message by ID (used for testing).
func (s *MessageStoreImpl) GetByID(_ context.Context, id string) (*domain.Message, error) {
	var model MessageModel
	if err := s.db.Reader.Where("id = ?", id).First(&model).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, &domain.NotFoundError{Resource: "message", ID: id}
		}
		return nil, err
	}
	return model.ToDomain(), nil
}

func toMessageDomainSlice(models []MessageModel) []*domain.Message {
	msgs := make([]*domain.Message, len(models))
	for i := range models {
		msgs[i] = models[i].ToDomain()
	}
	return msgs
}
