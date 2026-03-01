package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupLoggerTest(t *testing.T) (*DBLogger, domain.LogStore, *bytes.Buffer) {
	t.Helper()
	db, err := store.NewInMemoryDB()
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })

	logStore := store.NewLogStore(db)
	var buf bytes.Buffer
	slogger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	logger := NewDBLogger(logStore, domain.LogLevelInfo, slogger)
	t.Cleanup(func() { logger.Stop() })

	return logger, logStore, &buf
}

func waitForBatch(t *testing.T, logStore domain.LogStore, expectedMin int64) {
	t.Helper()
	require.Eventually(t, func() bool {
		count, err := logStore.Count(context.Background())
		if err != nil {
			return false
		}
		return count >= expectedMin
	}, 2*time.Second, 10*time.Millisecond)
}

func TestDBLogger_LogEntryStoredInDB(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "api",
		Action:    "request",
		Message:   "handling GET /health",
	})

	waitForBatch(t, logStore, 1)

	entries, err := logStore.Query(context.Background(), domain.LogQueryOpts{Limit: 10})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "api", entries[0].Component)
	assert.Equal(t, "request", entries[0].Action)
	assert.Equal(t, "handling GET /health", entries[0].Message)
}

func TestDBLogger_BelowLevelNotStored(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelDebug,
		Component: "api",
		Action:    "debug",
		Message:   "debug message",
	})

	// Give time for potential flush
	time.Sleep(200 * time.Millisecond)

	count, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(0), count)
}

func TestDBLogger_SensitiveFieldRedaction(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	params := json.RawMessage(`{"api_key": "sk-secret-123", "name": "test"}`)
	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "config",
		Action:    "update",
		Message:   "updating provider",
		Params:    params,
	})

	waitForBatch(t, logStore, 1)

	entries, err := logStore.Query(context.Background(), domain.LogQueryOpts{Limit: 10})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Contains(t, string(entries[0].Params), "[REDACTED]")
	assert.NotContains(t, string(entries[0].Params), "sk-secret-123")
}

func TestDBLogger_DualOutput(t *testing.T) {
	logger, logStore, buf := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "ws",
		Action:    "connect",
		Message:   "team connected",
	})

	waitForBatch(t, logStore, 1)

	// Verify DB entry
	entries, err := logStore.Query(context.Background(), domain.LogQueryOpts{Limit: 10})
	require.NoError(t, err)
	assert.Len(t, entries, 1)

	// Verify slog output
	output := buf.String()
	assert.Contains(t, output, "team connected")
	assert.Contains(t, output, "ws")
}

func TestDBLogger_BatchFlushOn50Entries(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	for i := range 50 {
		logger.Log(&domain.LogEntry{
			Level:     domain.LogLevelInfo,
			Component: "test",
			Action:    "batch",
			Message:   "entry",
			TaskID:    string(rune('0' + i%10)),
		})
	}

	waitForBatch(t, logStore, 50)

	count, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.GreaterOrEqual(t, count, int64(50))
}

func TestDBLogger_BatchFlushAfterTimeout(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	// Send just one entry (below batch size)
	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "test",
		Action:    "timeout",
		Message:   "single entry",
	})

	// Wait for flush interval (100ms) plus some buffer
	waitForBatch(t, logStore, 1)

	count, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestDBLogger_GracefulShutdownFlushesRemaining(t *testing.T) {
	db, err := store.NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	logStore := store.NewLogStore(db)
	var buf bytes.Buffer
	slogger := slog.New(slog.NewTextHandler(&buf, nil))

	logger := NewDBLogger(logStore, domain.LogLevelInfo, slogger)

	// Send a few entries
	for range 3 {
		logger.Log(&domain.LogEntry{
			Level:     domain.LogLevelInfo,
			Component: "test",
			Action:    "shutdown",
			Message:   "pre-shutdown entry",
		})
	}

	// Stop immediately - should flush pending entries
	logger.Stop()

	count, logErr := logStore.Count(context.Background())
	require.NoError(t, logErr)
	assert.Equal(t, int64(3), count)
}

func TestDBLogger_NonBlockingSend(t *testing.T) {
	logger, _, _ := setupLoggerTest(t)

	// This should not block even if channel is full
	done := make(chan struct{})
	go func() {
		for range 2000 {
			logger.Log(&domain.LogEntry{
				Level:     domain.LogLevelInfo,
				Component: "test",
				Action:    "flood",
				Message:   "entry",
			})
		}
		close(done)
	}()

	select {
	case <-done:
		// OK - did not block
	case <-time.After(5 * time.Second):
		t.Fatal("logging blocked the caller")
	}
}

func TestDBLogger_RedactionBeforeDBWrite(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	params := json.RawMessage(`{"master_key": "super-secret-key-value", "action": "unlock"}`)
	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "auth",
		Action:    "unlock",
		Message:   "key unlocked",
		Params:    params,
	})

	waitForBatch(t, logStore, 1)

	entries, err := logStore.Query(context.Background(), domain.LogQueryOpts{Limit: 10})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.NotContains(t, string(entries[0].Params), "super-secret-key-value")
	assert.Contains(t, string(entries[0].Params), "[REDACTED]")
}

func TestDBLogger_SetsTimestamp(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	before := time.Now()
	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "test",
		Action:    "ts",
		Message:   "timestamp test",
	})

	waitForBatch(t, logStore, 1)

	entries, err := logStore.Query(context.Background(), domain.LogQueryOpts{Limit: 10})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.False(t, entries[0].CreatedAt.IsZero())
	assert.True(t, entries[0].CreatedAt.After(before) || entries[0].CreatedAt.Equal(before))
}

func TestDBLogger_SlogOutputIncludesAttributes(t *testing.T) {
	logger, _, buf := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:      domain.LogLevelError,
		Component:  "ws",
		Action:     "disconnect",
		Message:    "team disconnected",
		TeamName:   "my-team",
		TaskID:     "task-001",
		AgentName:  "agent-helper",
		RequestID:  "req-123",
		Error:      "connection reset",
		DurationMs: 150,
	})

	// Wait for slog output
	time.Sleep(50 * time.Millisecond)

	output := buf.String()
	assert.Contains(t, output, "team disconnected")
	assert.Contains(t, output, "my-team")
	assert.Contains(t, output, "task-001")
	assert.Contains(t, output, "agent-helper")
	assert.Contains(t, output, "req-123")
	assert.Contains(t, output, "connection reset")
	assert.Contains(t, output, "150")
}

func TestDBLogger_WarnLevel(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelWarn,
		Component: "test",
		Action:    "warn",
		Message:   "warning message",
	})

	waitForBatch(t, logStore, 1)

	count, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestDBLogger_ErrorLevel(t *testing.T) {
	logger, logStore, _ := setupLoggerTest(t)

	logger.Log(&domain.LogEntry{
		Level:     domain.LogLevelError,
		Component: "test",
		Action:    "error",
		Message:   "error message",
	})

	waitForBatch(t, logStore, 1)

	count, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}
