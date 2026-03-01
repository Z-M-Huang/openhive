package store

import (
	"fmt"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// DB wraps writer and reader GORM instances with SQLite-specific configuration.
type DB struct {
	Writer *gorm.DB
	Reader *gorm.DB
}

// NewDB creates a new DB with separate writer and reader connection pools.
// Writer: MaxOpenConns=1 (single writer for SQLite)
// Reader: MaxOpenConns=4 (concurrent readers with WAL)
func NewDB(dsn string) (*DB, error) {
	gormCfg := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	}

	writer, err := gorm.Open(sqlite.Open(dsn), gormCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to open writer DB: %w", err)
	}

	writerSQL, err := writer.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get writer sql.DB: %w", err)
	}
	writerSQL.SetMaxOpenConns(1)

	err = setPragmas(writer)
	if err != nil {
		return nil, err
	}

	reader, err := gorm.Open(sqlite.Open(dsn), gormCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to open reader DB: %w", err)
	}

	readerSQL, err := reader.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get reader sql.DB: %w", err)
	}
	readerSQL.SetMaxOpenConns(4)

	err = setPragmas(reader)
	if err != nil {
		return nil, err
	}

	err = writer.AutoMigrate(
		&TaskModel{},
		&MessageModel{},
		&LogEntryModel{},
		&ChatSessionModel{},
	)
	if err != nil {
		return nil, fmt.Errorf("failed to auto-migrate: %w", err)
	}

	return &DB{Writer: writer, Reader: reader}, nil
}

// NewInMemoryDB creates an in-memory SQLite database for testing.
func NewInMemoryDB() (*DB, error) {
	return NewDB("file::memory:?cache=shared")
}

func setPragmas(db *gorm.DB) error {
	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA synchronous=NORMAL",
	}
	for _, p := range pragmas {
		if err := db.Exec(p).Error; err != nil {
			return fmt.Errorf("failed to set pragma %s: %w", p, err)
		}
	}
	return nil
}

// Close closes both writer and reader connections.
func (d *DB) Close() error {
	writerSQL, err := d.Writer.DB()
	if err != nil {
		return err
	}
	err = writerSQL.Close()
	if err != nil {
		return err
	}

	readerSQL, err := d.Reader.DB()
	if err != nil {
		return err
	}
	return readerSQL.Close()
}

// WithTransaction runs a function within a database transaction.
func (d *DB) WithTransaction(fn func(tx *gorm.DB) error) error {
	return d.Writer.Transaction(fn)
}
