package store

import (
	"context"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTaskStore(t *testing.T) (*TaskStoreImpl, func()) {
	t.Helper()
	db, err := NewInMemoryDB()
	require.NoError(t, err)
	return NewTaskStore(db), func() { db.Close() }
}

func TestTaskStore_CRUD(t *testing.T) {
	store, cleanup := setupTaskStore(t)
	defer cleanup()
	ctx := context.Background()

	task := &domain.Task{
		ID:       "task-001",
		TeamSlug: "team-a",
		AgentAID: "aid-agent-001",
		Status:   domain.TaskStatusPending,
		Prompt:   "do something",
	}

	// Create
	require.NoError(t, store.Create(ctx, task))

	// Read
	got, err := store.Get(ctx, "task-001")
	require.NoError(t, err)
	assert.Equal(t, "task-001", got.ID)
	assert.Equal(t, "team-a", got.TeamSlug)
	assert.Equal(t, domain.TaskStatusPending, got.Status)
	assert.Equal(t, "do something", got.Prompt)

	// Update
	task.Status = domain.TaskStatusRunning
	require.NoError(t, store.Update(ctx, task))
	got, err = store.Get(ctx, "task-001")
	require.NoError(t, err)
	assert.Equal(t, domain.TaskStatusRunning, got.Status)

	// Delete
	require.NoError(t, store.Delete(ctx, "task-001"))
	_, err = store.Get(ctx, "task-001")
	assert.Error(t, err)
}

func TestTaskStore_GetNotFound(t *testing.T) {
	store, cleanup := setupTaskStore(t)
	defer cleanup()

	_, err := store.Get(context.Background(), "nonexistent")
	assert.Error(t, err)
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
}

func TestTaskStore_ListByTeam(t *testing.T) {
	store, cleanup := setupTaskStore(t)
	defer cleanup()
	ctx := context.Background()

	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t1", TeamSlug: "team-a", Status: domain.TaskStatusPending}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t2", TeamSlug: "team-a", Status: domain.TaskStatusRunning}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t3", TeamSlug: "team-b", Status: domain.TaskStatusPending}))

	tasks, err := store.ListByTeam(ctx, "team-a")
	require.NoError(t, err)
	assert.Len(t, tasks, 2)
}

func TestTaskStore_ListByStatus(t *testing.T) {
	store, cleanup := setupTaskStore(t)
	defer cleanup()
	ctx := context.Background()

	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t1", TeamSlug: "team-a", Status: domain.TaskStatusPending}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t2", TeamSlug: "team-a", Status: domain.TaskStatusRunning}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "t3", TeamSlug: "team-b", Status: domain.TaskStatusPending}))

	tasks, err := store.ListByStatus(ctx, domain.TaskStatusPending)
	require.NoError(t, err)
	assert.Len(t, tasks, 2)
}

func TestTaskStore_GetSubtree(t *testing.T) {
	store, cleanup := setupTaskStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now()
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "root", TeamSlug: "team-a", Status: domain.TaskStatusPending, CreatedAt: now}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "child-1", ParentID: "root", TeamSlug: "team-a", Status: domain.TaskStatusPending, CreatedAt: now}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "child-2", ParentID: "root", TeamSlug: "team-a", Status: domain.TaskStatusPending, CreatedAt: now}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "grandchild", ParentID: "child-1", TeamSlug: "team-a", Status: domain.TaskStatusPending, CreatedAt: now}))
	require.NoError(t, store.Create(ctx, &domain.Task{ID: "unrelated", TeamSlug: "team-a", Status: domain.TaskStatusPending, CreatedAt: now}))

	subtree, err := store.GetSubtree(ctx, "root")
	require.NoError(t, err)
	assert.Len(t, subtree, 4) // root + child-1 + child-2 + grandchild
}
