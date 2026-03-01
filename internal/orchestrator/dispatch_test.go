package orchestrator

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockTaskStore "github.com/Z-M-Huang/openhive/internal/mocks/TaskStore"
	mockWSHub "github.com/Z-M-Huang/openhive/internal/mocks/WSHub"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func newTestDispatcher(t *testing.T) (*Dispatcher, *mockTaskStore.MockTaskStore, *mockWSHub.MockWSHub) {
	t.Helper()
	ts := mockTaskStore.NewMockTaskStore(t)
	hub := mockWSHub.NewMockWSHub(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	d := NewDispatcher(ts, hub, logger)
	return d, ts, hub
}

func TestCreateAndDispatch_Success(t *testing.T) {
	d, ts, hub := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Create(ctx, mock.MatchedBy(func(task *domain.Task) bool {
		return task.Status == domain.TaskStatusPending &&
			task.TeamSlug == "main" &&
			task.Prompt == "Write tests" &&
			task.AgentAID == "aid-001" &&
			task.ID != ""
	})).Return(nil)

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	ts.EXPECT().Update(ctx, mock.MatchedBy(func(task *domain.Task) bool {
		return task.Status == domain.TaskStatusRunning
	})).Return(nil)

	task, err := d.CreateAndDispatch(ctx, "main", "aid-001", "Write tests", "")
	require.NoError(t, err)
	assert.NotEmpty(t, task.ID)
	assert.Equal(t, "main", task.TeamSlug)
}

func TestCreateAndDispatch_WithParentID(t *testing.T) {
	d, ts, hub := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Create(ctx, mock.MatchedBy(func(task *domain.Task) bool {
		return task.ParentID == "parent-001"
	})).Return(nil)

	hub.EXPECT().SendToTeam("team-a", mock.Anything).Return(nil)

	ts.EXPECT().Update(ctx, mock.Anything).Return(nil)

	task, err := d.CreateAndDispatch(ctx, "team-a", "aid-002", "Subtask", "parent-001")
	require.NoError(t, err)
	assert.Equal(t, "parent-001", task.ParentID)
}

func TestCreateAndDispatch_ContainerNotConnected(t *testing.T) {
	d, ts, hub := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Create(ctx, mock.Anything).Return(nil)

	// Container not connected
	hub.EXPECT().SendToTeam("offline-team", mock.Anything).Return(
		assert.AnError,
	)

	task, err := d.CreateAndDispatch(ctx, "offline-team", "aid-003", "Work", "")
	require.NoError(t, err) // Task should still be created
	assert.Equal(t, domain.TaskStatusPending, task.Status) // Not updated to running
}

func TestCreateAndDispatch_TaskStoreError(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Create(ctx, mock.Anything).Return(assert.AnError)

	task, err := d.CreateAndDispatch(ctx, "main", "aid-001", "Fail", "")
	assert.Error(t, err)
	assert.Nil(t, task)
}

func TestHandleResult_Completed(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Get(ctx, "task-001").Return(&domain.Task{
		ID:       "task-001",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
	}, nil)

	ts.EXPECT().Update(ctx, mock.MatchedBy(func(task *domain.Task) bool {
		return task.ID == "task-001" &&
			task.Status == domain.TaskStatusCompleted &&
			task.Result == "Done" &&
			task.CompletedAt != nil
	})).Return(nil)

	result := &ws.TaskResultMsg{
		TaskID:   "task-001",
		AgentAID: "aid-001",
		Status:   "completed",
		Result:   "Done",
	}

	err := d.HandleResult(ctx, result)
	assert.NoError(t, err)
}

func TestHandleResult_Failed(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Get(ctx, "task-002").Return(&domain.Task{
		ID:       "task-002",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
	}, nil)

	ts.EXPECT().Update(ctx, mock.MatchedBy(func(task *domain.Task) bool {
		return task.Status == domain.TaskStatusFailed && task.Error == "boom"
	})).Return(nil)

	result := &ws.TaskResultMsg{
		TaskID:   "task-002",
		AgentAID: "aid-001",
		Status:   "failed",
		Error:    "boom",
	}

	err := d.HandleResult(ctx, result)
	assert.NoError(t, err)
}

func TestHandleResult_TaskNotFound(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Get(ctx, "task-missing").Return(nil, &domain.NotFoundError{Resource: "task", ID: "task-missing"})

	result := &ws.TaskResultMsg{
		TaskID: "task-missing",
		Status: "completed",
	}

	err := d.HandleResult(ctx, result)
	assert.Error(t, err)
}

func TestHandleResult_InvalidStatus(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)
	ctx := context.Background()

	ts.EXPECT().Get(ctx, "task-003").Return(&domain.Task{
		ID:     "task-003",
		Status: domain.TaskStatusRunning,
	}, nil)

	result := &ws.TaskResultMsg{
		TaskID: "task-003",
		Status: "invalid_status",
	}

	err := d.HandleResult(ctx, result)
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestHandleWSMessage_TaskResult(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)

	ts.EXPECT().Get(mock.Anything, "task-ws-001").Return(&domain.Task{
		ID:     "task-ws-001",
		Status: domain.TaskStatusRunning,
	}, nil)
	ts.EXPECT().Update(mock.Anything, mock.Anything).Return(nil)

	msg, err := ws.EncodeMessage(ws.MsgTypeTaskResult, ws.TaskResultMsg{
		TaskID: "task-ws-001",
		Status: "completed",
		Result: "WS result",
	})
	require.NoError(t, err)

	// Should not panic
	d.HandleWSMessage("main", msg)
}

func TestHandleWSMessage_Ready(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	msg, err := ws.EncodeMessage(ws.MsgTypeReady, ws.ReadyMsg{
		TeamID:     "main",
		AgentCount: 2,
	})
	require.NoError(t, err)

	// Should not panic
	d.HandleWSMessage("main", msg)
}

func TestHandleWSMessage_InvalidJSON(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	// Should not panic on invalid JSON
	d.HandleWSMessage("main", []byte("not json"))
}

func TestSendContainerInit(t *testing.T) {
	d, _, hub := newTestDispatcher(t)

	agents := []ws.AgentInitConfig{
		{
			AID:       "aid-001",
			Name:      "helper",
			Provider:  ws.ProviderConfig{Type: "oauth", OAuthToken: "tok-123"},
			ModelTier: "sonnet",
		},
	}

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := d.SendContainerInit("main", true, agents, map[string]string{"SECRET": "value"})
	assert.NoError(t, err)
}
