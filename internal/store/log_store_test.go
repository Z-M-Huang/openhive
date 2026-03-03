package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupLogStore(t *testing.T) (*LogStoreImpl, func()) {
	t.Helper()
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	return NewLogStore(db), func() { db.Close() }
}

func TestLogStore_CreateAndQuery(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "api", Action: "request", Message: "handled request", Params: json.RawMessage(`{"path":"/health"}`), CreatedAt: time.Now()},
		{Level: domain.LogLevelError, Component: "ws", Action: "connect", Message: "connection failed", CreatedAt: time.Now()},
	}

	require.NoError(t, store.Create(ctx, entries))

	count, err := store.Count(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}

func TestLogStore_QueryByLevel(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelDebug, Component: "test", Action: "test", Message: "debug msg", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "info msg", CreatedAt: time.Now()},
		{Level: domain.LogLevelError, Component: "test", Action: "test", Message: "error msg", CreatedAt: time.Now()},
	}
	require.NoError(t, store.Create(ctx, entries))

	errorLevel := domain.LogLevelError
	results, err := store.Query(ctx, domain.LogQueryOpts{Level: &errorLevel, Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "error msg", results[0].Message)
}

func TestLogStore_QueryByComponent(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "api", Action: "test", Message: "api msg", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "ws", Action: "test", Message: "ws msg", CreatedAt: time.Now()},
	}
	require.NoError(t, store.Create(ctx, entries))

	results, err := store.Query(ctx, domain.LogQueryOpts{Component: "api", Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "api msg", results[0].Message)
}

func TestLogStore_QueryByDateRange(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now()
	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "old", CreatedAt: now.Add(-2 * time.Hour)},
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "recent", CreatedAt: now},
	}
	require.NoError(t, store.Create(ctx, entries))

	since := now.Add(-time.Hour)
	results, err := store.Query(ctx, domain.LogQueryOpts{Since: &since, Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "recent", results[0].Message)
}

func TestLogStore_DeleteBefore(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now()
	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "old", CreatedAt: now.Add(-2 * time.Hour)},
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "recent", CreatedAt: now},
	}
	require.NoError(t, store.Create(ctx, entries))

	deleted, err := store.DeleteBefore(ctx, now.Add(-time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)

	count, err := store.Count(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestLogStore_GetOldest(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now()
	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "third", CreatedAt: now.Add(2 * time.Second)},
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "first", CreatedAt: now},
		{Level: domain.LogLevelInfo, Component: "test", Action: "test", Message: "second", CreatedAt: now.Add(time.Second)},
	}
	require.NoError(t, store.Create(ctx, entries))

	oldest, err := store.GetOldest(ctx, 2)
	require.NoError(t, err)
	assert.Len(t, oldest, 2)
	assert.Equal(t, "first", oldest[0].Message)
	assert.Equal(t, "second", oldest[1].Message)
}

func TestLogStore_QueryByTeamName(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "api", Action: "test", Message: "team-a msg", TeamName: "team-a", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "api", Action: "test", Message: "team-b msg", TeamName: "team-b", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "api", Action: "test", Message: "no team", CreatedAt: time.Now()},
	}
	require.NoError(t, store.Create(ctx, entries))

	results, err := store.Query(ctx, domain.LogQueryOpts{TeamName: "team-a", Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "team-a msg", results[0].Message)
}

func TestLogStore_QueryByAgentName(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "ws", Action: "test", Message: "agent-1 msg", AgentName: "researcher", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "ws", Action: "test", Message: "agent-2 msg", AgentName: "coder", CreatedAt: time.Now()},
	}
	require.NoError(t, store.Create(ctx, entries))

	results, err := store.Query(ctx, domain.LogQueryOpts{AgentName: "researcher", Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "agent-1 msg", results[0].Message)
}

func TestLogStore_QueryByTaskID(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()
	ctx := context.Background()

	entries := []*domain.LogEntry{
		{Level: domain.LogLevelInfo, Component: "orch", Action: "dispatch", Message: "task-1 msg", TaskID: "task-001", CreatedAt: time.Now()},
		{Level: domain.LogLevelInfo, Component: "orch", Action: "dispatch", Message: "task-2 msg", TaskID: "task-002", CreatedAt: time.Now()},
	}
	require.NoError(t, store.Create(ctx, entries))

	results, err := store.Query(ctx, domain.LogQueryOpts{TaskID: "task-001", Limit: 100})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, "task-1 msg", results[0].Message)
}

func TestLogStore_CreateEmpty(t *testing.T) {
	store, cleanup := setupLogStore(t)
	defer cleanup()

	err := store.Create(context.Background(), []*domain.LogEntry{})
	assert.NoError(t, err)
}
