package store

import (
	"context"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupMessageStore(t *testing.T) (*MessageStoreImpl, func()) {
	t.Helper()
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	return NewMessageStore(db), func() { db.Close() }
}

func TestMessageStore_CreateAndGetByChat(t *testing.T) {
	store, cleanup := setupMessageStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now().Truncate(time.Millisecond)
	msg := &domain.Message{
		ID:        "msg-001",
		ChatJID:   "cli:local",
		Role:      "user",
		Content:   "hello",
		Timestamp: now,
	}

	require.NoError(t, store.Create(ctx, msg))

	msgs, err := store.GetByChat(ctx, "cli:local", now.Add(-time.Second), 10)
	require.NoError(t, err)
	assert.Len(t, msgs, 1)
	assert.Equal(t, "hello", msgs[0].Content)
}

func TestMessageStore_GetLatest(t *testing.T) {
	store, cleanup := setupMessageStore(t)
	defer cleanup()
	ctx := context.Background()

	base := time.Now().Truncate(time.Millisecond)
	for i := 0; i < 5; i++ {
		require.NoError(t, store.Create(ctx, &domain.Message{
			ID:        "msg-" + string(rune('a'+i)),
			ChatJID:   "cli:local",
			Role:      "user",
			Content:   "message " + string(rune('a'+i)),
			Timestamp: base.Add(time.Duration(i) * time.Second),
		}))
	}

	latest, err := store.GetLatest(ctx, "cli:local", 3)
	require.NoError(t, err)
	assert.Len(t, latest, 3)
	// Should be in chronological order (oldest first)
	assert.Equal(t, "message c", latest[0].Content)
	assert.Equal(t, "message e", latest[2].Content)
}

func TestMessageStore_DeleteByChat(t *testing.T) {
	store, cleanup := setupMessageStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now().Truncate(time.Millisecond)
	require.NoError(t, store.Create(ctx, &domain.Message{ID: "msg-1", ChatJID: "cli:local", Role: "user", Content: "hi", Timestamp: now}))
	require.NoError(t, store.Create(ctx, &domain.Message{ID: "msg-2", ChatJID: "cli:local", Role: "assistant", Content: "hello", Timestamp: now}))

	require.NoError(t, store.DeleteByChat(ctx, "cli:local"))

	msgs, err := store.GetByChat(ctx, "cli:local", now.Add(-time.Hour), 100)
	require.NoError(t, err)
	assert.Empty(t, msgs)
}
