package store

import (
	"context"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupSessionStore(t *testing.T) (*SessionStoreImpl, func()) {
	t.Helper()
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	return NewSessionStore(db), func() { db.Close() }
}

func TestSessionStore_UpsertAndGet(t *testing.T) {
	store, cleanup := setupSessionStore(t)
	defer cleanup()
	ctx := context.Background()

	session := &domain.ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
		SessionID:   "sess-001",
		AgentAID:    "aid-main-001",
	}

	require.NoError(t, store.Upsert(ctx, session))

	got, err := store.Get(ctx, "cli:local")
	require.NoError(t, err)
	assert.Equal(t, "cli:local", got.ChatJID)
	assert.Equal(t, "sess-001", got.SessionID)
}

func TestSessionStore_UpsertUpdate(t *testing.T) {
	store, cleanup := setupSessionStore(t)
	defer cleanup()
	ctx := context.Background()

	session := &domain.ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
		SessionID:   "sess-001",
	}
	require.NoError(t, store.Upsert(ctx, session))

	// Update
	session.SessionID = "sess-002"
	session.LastTimestamp = time.Now().Truncate(time.Millisecond)
	require.NoError(t, store.Upsert(ctx, session))

	got, err := store.Get(ctx, "cli:local")
	require.NoError(t, err)
	assert.Equal(t, "sess-002", got.SessionID)
}

func TestSessionStore_GetNotFound(t *testing.T) {
	store, cleanup := setupSessionStore(t)
	defer cleanup()

	_, err := store.Get(context.Background(), "nonexistent")
	assert.Error(t, err)
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
}

func TestSessionStore_Delete(t *testing.T) {
	store, cleanup := setupSessionStore(t)
	defer cleanup()
	ctx := context.Background()

	session := &domain.ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
	}
	require.NoError(t, store.Upsert(ctx, session))
	require.NoError(t, store.Delete(ctx, "cli:local"))

	_, err := store.Get(ctx, "cli:local")
	assert.Error(t, err)
}

func TestSessionStore_ListAll(t *testing.T) {
	store, cleanup := setupSessionStore(t)
	defer cleanup()
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, &domain.ChatSession{ChatJID: "cli:local", ChannelType: "cli"}))
	require.NoError(t, store.Upsert(ctx, &domain.ChatSession{ChatJID: "discord:123", ChannelType: "discord"}))

	sessions, err := store.ListAll(ctx)
	require.NoError(t, err)
	assert.Len(t, sessions, 2)
}
