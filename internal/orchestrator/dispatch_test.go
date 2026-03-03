package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"sync"
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

func TestHandleWSMessage_RejectsGoToContainerType(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	// A container should NOT be able to send a container_init message.
	// The dispatcher should reject it via direction validation.
	msg, err := ws.EncodeMessage(ws.MsgTypeContainerInit, ws.ContainerInitMsg{
		IsMainAssistant: true,
		Agents:          []ws.AgentInitConfig{},
	})
	require.NoError(t, err)

	// Should not panic and should be silently rejected (logged)
	d.HandleWSMessage("malicious-team", msg)
	// No task store calls expected (verified by mockery - no expectations set)
}

func TestHandleWSMessage_RejectsTaskDispatchFromContainer(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	// A container should NOT be able to send a task_dispatch message.
	msg, err := ws.EncodeMessage(ws.MsgTypeTaskDispatch, ws.TaskDispatchMsg{
		TaskID:   "task-fake",
		AgentAID: "aid-fake-001",
		Prompt:   "malicious prompt",
	})
	require.NoError(t, err)

	// Should not panic and should be silently rejected
	d.HandleWSMessage("malicious-team", msg)
}

func TestHandleWSMessage_RejectsShutdownFromContainer(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	msg, err := ws.EncodeMessage(ws.MsgTypeShutdown, ws.ShutdownMsg{
		Reason:  "malicious shutdown",
		Timeout: 0,
	})
	require.NoError(t, err)

	d.HandleWSMessage("malicious-team", msg)
}

func TestHandleWSMessage_RejectsToolResultFromContainer(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	msg, err := ws.EncodeMessage(ws.MsgTypeToolResult, ws.ToolResultMsg{
		CallID: "call-fake",
	})
	require.NoError(t, err)

	d.HandleWSMessage("malicious-team", msg)
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

	err := d.SendContainerInit("main", true, agents, map[string]string{"SECRET": "value"}, "/openhive/workspace")
	assert.NoError(t, err)
}

func TestSetToolHandler(t *testing.T) {
	d, _, _ := newTestDispatcher(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	th := NewToolHandler(logger)

	d.SetToolHandler(th)
	assert.Equal(t, th, d.toolHandler)
}

func TestSetTaskResultCallback(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	called := false
	d.SetTaskResultCallback(func(_ context.Context, _ *ws.TaskResultMsg) {
		called = true
	})

	assert.NotNil(t, d.taskResultCallback)
	d.taskResultCallback(context.Background(), &ws.TaskResultMsg{})
	assert.True(t, called)
}

func TestHandleWSMessage_ToolCall_Success(t *testing.T) {
	d, _, hub := newTestDispatcher(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create and wire a tool handler with a test tool
	th := NewToolHandler(logger)
	th.Register("test_tool", func(args json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"status":"ok"}`), nil
	})
	d.SetToolHandler(th)

	// Expect tool_result to be sent back to the team (use "main" for full tool access)
	hub.EXPECT().SendToTeam("main", mock.MatchedBy(func(data []byte) bool {
		msgType, payload, err := ws.ParseMessage(data)
		if err != nil || msgType != ws.MsgTypeToolResult {
			return false
		}
		result, ok := payload.(*ws.ToolResultMsg)
		return ok && result.CallID == "call-123" && result.ErrorCode == ""
	})).Return(nil)

	msg, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:    "call-123",
		ToolName:  "test_tool",
		Arguments: json.RawMessage(`{}`),
		AgentAID:  "aid-001",
	})
	require.NoError(t, err)

	d.HandleWSMessage("main", msg)
}

func TestHandleWSMessage_ToolCall_ToolError(t *testing.T) {
	d, _, hub := newTestDispatcher(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Register a tool that fails
	th := NewToolHandler(logger)
	th.Register("fail_tool", func(args json.RawMessage) (json.RawMessage, error) {
		return nil, &domain.NotFoundError{Resource: "item", ID: "xyz"}
	})
	d.SetToolHandler(th)

	// Expect error tool_result to be sent back (use "main" for full tool access)
	hub.EXPECT().SendToTeam("main", mock.MatchedBy(func(data []byte) bool {
		msgType, payload, err := ws.ParseMessage(data)
		if err != nil || msgType != ws.MsgTypeToolResult {
			return false
		}
		result, ok := payload.(*ws.ToolResultMsg)
		return ok && result.CallID == "call-456" && result.ErrorCode == ws.WSErrorNotFound
	})).Return(nil)

	msg, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:    "call-456",
		ToolName:  "fail_tool",
		Arguments: json.RawMessage(`{}`),
		AgentAID:  "aid-001",
	})
	require.NoError(t, err)

	d.HandleWSMessage("main", msg)
}

func TestHandleWSMessage_ToolCall_UnknownTool(t *testing.T) {
	d, _, hub := newTestDispatcher(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Empty tool handler - no tools registered
	th := NewToolHandler(logger)
	d.SetToolHandler(th)

	// Expect error tool_result for unknown tool (use "main" for full tool access)
	hub.EXPECT().SendToTeam("main", mock.MatchedBy(func(data []byte) bool {
		msgType, payload, err := ws.ParseMessage(data)
		if err != nil || msgType != ws.MsgTypeToolResult {
			return false
		}
		result, ok := payload.(*ws.ToolResultMsg)
		return ok && result.CallID == "call-789" && result.ErrorCode != ""
	})).Return(nil)

	msg, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:    "call-789",
		ToolName:  "nonexistent_tool",
		Arguments: json.RawMessage(`{}`),
		AgentAID:  "aid-001",
	})
	require.NoError(t, err)

	d.HandleWSMessage("main", msg)
}

func TestHandleWSMessage_ToolCall_ChildTeamAuthorization(t *testing.T) {
	d, _, hub := newTestDispatcher(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Register both a whitelisted and non-whitelisted tool
	th := NewToolHandler(logger)
	th.Register("get_task_status", func(args json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"status":"ok"}`), nil
	})
	th.Register("create_team", func(args json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"status":"created"}`), nil
	})
	d.SetToolHandler(th)

	// Child team calling whitelisted tool should succeed
	hub.EXPECT().SendToTeam("team-child", mock.MatchedBy(func(data []byte) bool {
		msgType, payload, err := ws.ParseMessage(data)
		if err != nil || msgType != ws.MsgTypeToolResult {
			return false
		}
		result, ok := payload.(*ws.ToolResultMsg)
		return ok && result.CallID == "call-whitelist" && result.ErrorCode == ""
	})).Return(nil)

	msg, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:   "call-whitelist",
		ToolName: "get_task_status",
		AgentAID: "aid-001",
	})
	require.NoError(t, err)
	d.HandleWSMessage("team-child", msg)

	// Child team calling non-whitelisted tool should be rejected
	hub.EXPECT().SendToTeam("team-child", mock.MatchedBy(func(data []byte) bool {
		msgType, payload, err := ws.ParseMessage(data)
		if err != nil || msgType != ws.MsgTypeToolResult {
			return false
		}
		result, ok := payload.(*ws.ToolResultMsg)
		return ok && result.CallID == "call-blocked" && result.ErrorCode == ws.WSErrorAccessDenied
	})).Return(nil)

	msg2, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:   "call-blocked",
		ToolName: "create_team",
		AgentAID: "aid-001",
	})
	require.NoError(t, err)
	d.HandleWSMessage("team-child", msg2)
}

func TestHandleWSMessage_ToolCall_NoHandler(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	// No tool handler set - should log error but not panic
	msg, err := ws.EncodeMessage(ws.MsgTypeToolCall, ws.ToolCallMsg{
		CallID:    "call-no-handler",
		ToolName:  "any_tool",
		Arguments: json.RawMessage(`{}`),
		AgentAID:  "aid-001",
	})
	require.NoError(t, err)

	// Should not panic - no hub expectations because no response should be sent
	d.HandleWSMessage("team-a", msg)
}

func TestHandleWSMessage_TaskResult_WithCallback(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)

	ts.EXPECT().Get(mock.Anything, "task-cb-001").Return(&domain.Task{
		ID:     "task-cb-001",
		Status: domain.TaskStatusRunning,
	}, nil)
	ts.EXPECT().Update(mock.Anything, mock.Anything).Return(nil)

	// Set up callback to track invocation
	var mu sync.Mutex
	var callbackResult *ws.TaskResultMsg
	d.SetTaskResultCallback(func(_ context.Context, result *ws.TaskResultMsg) {
		mu.Lock()
		callbackResult = result
		mu.Unlock()
	})

	msg, err := ws.EncodeMessage(ws.MsgTypeTaskResult, ws.TaskResultMsg{
		TaskID: "task-cb-001",
		Status: "completed",
		Result: "callback test",
	})
	require.NoError(t, err)

	d.HandleWSMessage("main", msg)

	mu.Lock()
	require.NotNil(t, callbackResult)
	assert.Equal(t, "task-cb-001", callbackResult.TaskID)
	assert.Equal(t, "callback test", callbackResult.Result)
	mu.Unlock()
}

func TestHandleWSMessage_TaskResult_NoCallback(t *testing.T) {
	d, ts, _ := newTestDispatcher(t)

	ts.EXPECT().Get(mock.Anything, "task-nocb-001").Return(&domain.Task{
		ID:     "task-nocb-001",
		Status: domain.TaskStatusRunning,
	}, nil)
	ts.EXPECT().Update(mock.Anything, mock.Anything).Return(nil)

	// No callback set - should not panic
	msg, err := ws.EncodeMessage(ws.MsgTypeTaskResult, ws.TaskResultMsg{
		TaskID: "task-nocb-001",
		Status: "completed",
	})
	require.NoError(t, err)

	d.HandleWSMessage("main", msg)
}

// --- mockHeartbeatMonitor for dispatcher tests ---

type mockHeartbeatMonitor struct {
	processHeartbeatCalled bool
	lastTeamID             string
	lastAgents             []domain.AgentHeartbeatStatus
	mu                     sync.Mutex
}

func (m *mockHeartbeatMonitor) ProcessHeartbeat(teamID string, agents []domain.AgentHeartbeatStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.processHeartbeatCalled = true
	m.lastTeamID = teamID
	m.lastAgents = agents
}
func (m *mockHeartbeatMonitor) GetStatus(teamID string) (*domain.HeartbeatStatus, error) { return nil, nil }
func (m *mockHeartbeatMonitor) GetAllStatuses() map[string]*domain.HeartbeatStatus       { return nil }
func (m *mockHeartbeatMonitor) SetOnUnhealthy(callback func(teamID string))              {}
func (m *mockHeartbeatMonitor) StartMonitoring()                                         {}
func (m *mockHeartbeatMonitor) StopMonitoring()                                          {}

func TestHandleWSMessage_Heartbeat_CallsMonitor(t *testing.T) {
	d, _, _ := newTestDispatcher(t)

	monitor := &mockHeartbeatMonitor{}
	d.SetHeartbeatMonitor(monitor)

	msg, err := ws.EncodeMessage(ws.MsgTypeHeartbeat, ws.HeartbeatMsg{
		TeamID: "team-hb-001",
		Agents: []ws.AgentStatus{
			{AID: "aid-001", Status: "idle", MemoryMB: 128.0},
		},
	})
	require.NoError(t, err)

	d.HandleWSMessage("team-hb-001", msg)

	monitor.mu.Lock()
	defer monitor.mu.Unlock()
	assert.True(t, monitor.processHeartbeatCalled)
	assert.Equal(t, "team-hb-001", monitor.lastTeamID)
	require.Len(t, monitor.lastAgents, 1)
	assert.Equal(t, "aid-001", monitor.lastAgents[0].AID)
}

func TestHandleWSMessage_Heartbeat_NoMonitor_DoesNotPanic(t *testing.T) {
	d, _, _ := newTestDispatcher(t)
	// No heartbeat monitor set

	msg, err := ws.EncodeMessage(ws.MsgTypeHeartbeat, ws.HeartbeatMsg{
		TeamID: "team-hb-002",
		Agents: []ws.AgentStatus{},
	})
	require.NoError(t, err)

	// Should not panic
	d.HandleWSMessage("team-hb-002", msg)
}
