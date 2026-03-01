package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestNewInMemoryDB(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	assert.NotNil(t, db.Writer)
	assert.NotNil(t, db.Reader)
}

func TestDB_PragmasSet(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	// Verify WAL mode (in-memory SQLite may return 'memory' instead of 'wal')
	var journalMode string
	db.Writer.Raw("PRAGMA journal_mode").Scan(&journalMode)
	assert.Contains(t, []string{"wal", "memory"}, journalMode)

	// Verify busy_timeout
	var busyTimeout int
	db.Writer.Raw("PRAGMA busy_timeout").Scan(&busyTimeout)
	assert.Equal(t, 5000, busyTimeout)

	// Verify synchronous mode (1 = NORMAL)
	var synchronous int
	db.Writer.Raw("PRAGMA synchronous").Scan(&synchronous)
	assert.Equal(t, 1, synchronous)
}

func TestDB_WriterMaxOpenConns(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	writerSQL, err := db.Writer.DB()
	require.NoError(t, err)
	stats := writerSQL.Stats()
	assert.Equal(t, 1, stats.MaxOpenConnections)
}

func TestDB_ReaderMaxOpenConns(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	readerSQL, err := db.Reader.DB()
	require.NoError(t, err)
	stats := readerSQL.Stats()
	assert.Equal(t, 4, stats.MaxOpenConnections)
}

func TestDB_Transaction(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	// Transaction that succeeds
	err = db.WithTransaction(func(tx *gorm.DB) error {
		return tx.Create(&TaskModel{ID: "tx-task-1", TeamSlug: "test", Status: 0}).Error
	})
	require.NoError(t, err)

	// Verify task was created
	var model TaskModel
	require.NoError(t, db.Reader.Where("id = ?", "tx-task-1").First(&model).Error)
	assert.Equal(t, "tx-task-1", model.ID)
}

func TestDB_TransactionRollback(t *testing.T) {
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	// Transaction that fails
	err = db.WithTransaction(func(tx *gorm.DB) error {
		createErr := tx.Create(&TaskModel{ID: "tx-task-2", TeamSlug: "test"}).Error
		if createErr != nil {
			return createErr
		}
		return assert.AnError // force rollback
	})
	assert.Error(t, err)

	// Verify task was not created
	var count int64
	db.Reader.Model(&TaskModel{}).Where("id = ?", "tx-task-2").Count(&count)
	assert.Equal(t, int64(0), count)
}
