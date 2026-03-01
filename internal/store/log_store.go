package store

import (
	"context"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// LogStoreImpl implements domain.LogStore using GORM.
type LogStoreImpl struct {
	db *DB
}

// NewLogStore creates a new LogStore.
func NewLogStore(db *DB) *LogStoreImpl {
	return &LogStoreImpl{db: db}
}

// Create inserts log entries in batch.
func (s *LogStoreImpl) Create(_ context.Context, entries []*domain.LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	models := make([]LogEntryModel, len(entries))
	for i, e := range entries {
		m := LogEntryModelFromDomain(e)
		m.ID = 0 // let autoincrement handle it
		models[i] = *m
	}
	return s.db.Writer.Create(&models).Error
}

// Query retrieves log entries matching the given filter options.
func (s *LogStoreImpl) Query(_ context.Context, opts domain.LogQueryOpts) ([]*domain.LogEntry, error) {
	query := s.db.Reader.Model(&LogEntryModel{})

	if opts.Level != nil {
		query = query.Where("level >= ?", int(*opts.Level))
	}
	if opts.Component != "" {
		query = query.Where("component = ?", opts.Component)
	}
	if opts.Since != nil {
		query = query.Where("created_at >= ?", *opts.Since)
	}
	if opts.Until != nil {
		query = query.Where("created_at <= ?", *opts.Until)
	}
	if opts.Offset > 0 {
		query = query.Offset(opts.Offset)
	}
	if opts.Limit > 0 {
		query = query.Limit(opts.Limit)
	} else {
		query = query.Limit(100) // default limit
	}

	var models []LogEntryModel
	if err := query.Order("created_at DESC").Find(&models).Error; err != nil {
		return nil, err
	}

	entries := make([]*domain.LogEntry, len(models))
	for i := range models {
		entries[i] = models[i].ToDomain()
	}
	return entries, nil
}

// DeleteBefore removes all log entries older than the given time.
func (s *LogStoreImpl) DeleteBefore(_ context.Context, before time.Time) (int64, error) {
	result := s.db.Writer.Where("created_at < ?", before).Delete(&LogEntryModel{})
	return result.RowsAffected, result.Error
}

// Count returns the total number of log entries.
func (s *LogStoreImpl) Count(_ context.Context) (int64, error) {
	var count int64
	if err := s.db.Reader.Model(&LogEntryModel{}).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

// GetOldest returns the N oldest log entries.
func (s *LogStoreImpl) GetOldest(_ context.Context, limit int) ([]*domain.LogEntry, error) {
	var models []LogEntryModel
	if err := s.db.Reader.Order("created_at ASC").Limit(limit).Find(&models).Error; err != nil {
		return nil, err
	}
	entries := make([]*domain.LogEntry, len(models))
	for i := range models {
		entries[i] = models[i].ToDomain()
	}
	return entries, nil
}
