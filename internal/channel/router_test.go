package channel

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockChannelAdapter "github.com/Z-M-Huang/openhive/internal/mocks/ChannelAdapter"
	mockSessionStore "github.com/Z-M-Huang/openhive/internal/mocks/SessionStore"
	mockTaskStore "github.com/Z-M-Huang/openhive/internal/mocks/TaskStore"
	mockWSHub "github.com/Z-M-Huang/openhive/internal/mocks/WSHub"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func newTestRouter(t *testing.T) (*Router, *mockWSHub.MockWSHub, *mockTaskStore.MockTaskStore, *mockSessionStore.MockSessionStore) {
	t.Helper()
	hub := mockWSHub.NewMockWSHub(t)
	ts := mockTaskStore.NewMockTaskStore(t)
	ss := mockSessionStore.NewMockSessionStore(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	r := NewRouter(RouterConfig{
		WSHub:        hub,
		TaskStore:    ts,
		SessionStore: ss,
		Logger:       logger,
		MainTeamID:   "main",
	})

	return r, hub, ts, ss
}

func newMockAdapter(t *testing.T, prefix string) *mockChannelAdapter.MockChannelAdapter {
	t.Helper()
	adapter := mockChannelAdapter.NewMockChannelAdapter(t)
	adapter.EXPECT().GetJIDPrefix().Return(prefix)
	adapter.EXPECT().OnMessage(mock.AnythingOfType("func(string, string)")).Return()
	return adapter
}

func TestRegisterChannel(t *testing.T) {
	r, _, _, _ := newTestRouter(t)
	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()

	err := r.RegisterChannel(adapter)
	assert.NoError(t, err)

	channels := r.GetChannels()
	assert.Contains(t, channels, "cli")
}

func TestRegisterChannel_DuplicatePrefix(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	adapter1 := newMockAdapter(t, "cli")

	// Second adapter does not need OnMessage mock since RegisterChannel
	// returns early with a conflict error before calling OnMessage.
	adapter2 := mockChannelAdapter.NewMockChannelAdapter(t)
	adapter2.EXPECT().GetJIDPrefix().Return("cli")

	err := r.RegisterChannel(adapter1)
	require.NoError(t, err)

	err = r.RegisterChannel(adapter2)
	assert.Error(t, err)
	var conflictErr *domain.ConflictError
	assert.ErrorAs(t, err, &conflictErr)
}

func TestRegisterChannel_EmptyPrefix(t *testing.T) {
	r, _, _, _ := newTestRouter(t)
	adapter := mockChannelAdapter.NewMockChannelAdapter(t)
	adapter.EXPECT().GetJIDPrefix().Return("")

	err := r.RegisterChannel(adapter)
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestUnregisterChannel(t *testing.T) {
	r, _, _, _ := newTestRouter(t)
	adapter := newMockAdapter(t, "cli")

	err := r.RegisterChannel(adapter)
	require.NoError(t, err)

	err = r.UnregisterChannel("cli")
	assert.NoError(t, err)

	channels := r.GetChannels()
	assert.NotContains(t, channels, "cli")
}

func TestUnregisterChannel_NotFound(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	err := r.UnregisterChannel("nonexistent")
	assert.Error(t, err)
	var notFoundErr *domain.NotFoundError
	assert.ErrorAs(t, err, &notFoundErr)
}

func TestRouteInbound_CreatesTaskAndDispatches(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	// Session does not exist yet, create new
	ss.EXPECT().Get(mock.Anything, "cli:local").Return(nil, &domain.NotFoundError{Resource: "session", ID: "cli:local"})
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "cli:local" && s.ChannelType == "cli"
	})).Return(nil)

	// Second upsert for timestamp update
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "cli:local"
	})).Return(nil)

	ts.EXPECT().Create(mock.Anything, mock.MatchedBy(func(task *domain.Task) bool {
		return task.Status == domain.TaskStatusPending &&
			task.TeamSlug == "main" &&
			task.Prompt != ""
	})).Return(nil)

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("cli:local", "Hello world")
	assert.NoError(t, err)
}

func TestRouteInbound_MessageFormatting(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	var capturedTask *domain.Task
	ts.EXPECT().Create(mock.Anything, mock.Anything).Run(func(_ context.Context, task *domain.Task) {
		capturedTask = task
	}).Return(nil)

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("cli:local", "Test message")
	require.NoError(t, err)

	assert.Contains(t, capturedTask.Prompt, `<user_message channel="cli" jid="cli:local">`)
	assert.Contains(t, capturedTask.Prompt, "Test message")
	assert.Contains(t, capturedTask.Prompt, "</user_message>")
}

func TestRouteOutbound_SendsToCorrectChannel(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()
	adapter.EXPECT().SendMessage("cli:local", "Hello back").Return(nil)

	err := r.RegisterChannel(adapter)
	require.NoError(t, err)

	err = r.RouteOutbound("cli:local", "Hello back")
	assert.NoError(t, err)
}

func TestRouteOutbound_UnknownPrefix(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	err := r.RouteOutbound("unknown:jid", "Hello")
	assert.Error(t, err)
	var notFoundErr *domain.NotFoundError
	assert.ErrorAs(t, err, &notFoundErr)
}

func TestRouteOutbound_StripsXMLTags(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()
	adapter.EXPECT().SendMessage("cli:local", "Clean response").Return(nil)

	err := r.RegisterChannel(adapter)
	require.NoError(t, err)

	err = r.RouteOutbound("cli:local", `<agent_response channel="cli">Clean response</agent_response>`)
	assert.NoError(t, err)
}

func TestGetChannels_ReturnsConnectionStatus(t *testing.T) {
	r, _, _, _ := newTestRouter(t)

	adapter1 := newMockAdapter(t, "cli")
	adapter1.EXPECT().IsConnected().Return(true)

	adapter2 := newMockAdapter(t, "discord")
	adapter2.EXPECT().IsConnected().Return(false)

	err := r.RegisterChannel(adapter1)
	require.NoError(t, err)
	err = r.RegisterChannel(adapter2)
	require.NoError(t, err)

	channels := r.GetChannels()
	assert.True(t, channels["cli"])
	assert.False(t, channels["discord"])
}

func TestHandleTaskResult_CompletedTask(t *testing.T) {
	r, _, ts, ss := newTestRouter(t)

	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()
	adapter.EXPECT().SendMessage("cli:local", "Task done").Return(nil)
	err := r.RegisterChannel(adapter)
	require.NoError(t, err)

	// Mock task retrieval
	ts.EXPECT().Get(mock.Anything, "task-001").Return(&domain.Task{
		ID:       "task-001",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
		Prompt:   `<user_message channel="cli" jid="cli:local">Do work</user_message>`,
	}, nil)

	ts.EXPECT().Update(mock.Anything, mock.MatchedBy(func(task *domain.Task) bool {
		return task.ID == "task-001" && task.Status == domain.TaskStatusCompleted
	})).Return(nil)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID: "cli:local",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	ctx := context.Background()
	result := &ws.TaskResultMsg{
		TaskID:   "task-001",
		AgentAID: "aid-001",
		Status:   "completed",
		Result:   "Task done",
	}

	err = r.HandleTaskResult(ctx, result)
	assert.NoError(t, err)
}

func TestHandleTaskResult_FailedTask(t *testing.T) {
	r, _, ts, ss := newTestRouter(t)

	ts.EXPECT().Get(mock.Anything, "task-002").Return(&domain.Task{
		ID:       "task-002",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
		Prompt:   `<user_message channel="cli" jid="cli:local">Fail</user_message>`,
	}, nil)

	ts.EXPECT().Update(mock.Anything, mock.MatchedBy(func(task *domain.Task) bool {
		return task.ID == "task-002" && task.Status == domain.TaskStatusFailed && task.Error == "something broke"
	})).Return(nil)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID: "cli:local",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	ctx := context.Background()
	result := &ws.TaskResultMsg{
		TaskID:   "task-002",
		AgentAID: "aid-001",
		Status:   "failed",
		Error:    "something broke",
	}

	err := r.HandleTaskResult(ctx, result)
	assert.NoError(t, err)
}

func TestSessionCreation_NewChat(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	// First call: session not found → create new
	ss.EXPECT().Get(mock.Anything, "discord:123").Return(nil, &domain.NotFoundError{Resource: "session", ID: "discord:123"})
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "discord:123" && s.ChannelType == "discord"
	})).Return(nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	ts.EXPECT().Create(mock.Anything, mock.Anything).Return(nil)
	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("discord:123", "Hello from Discord")
	assert.NoError(t, err)
}

func TestSessionResume_ExistingChat(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID:     "cli:local",
		ChannelType: "cli",
		SessionID:   "session-existing",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	ts.EXPECT().Create(mock.Anything, mock.Anything).Return(nil)
	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("cli:local", "Continue conversation")
	assert.NoError(t, err)
}

func TestFormatUserMessage(t *testing.T) {
	msg := FormatUserMessage("cli", "cli:local", "Hello world")
	assert.Equal(t, `<user_message channel="cli" jid="cli:local">Hello world</user_message>`, msg)
}

func TestStripResponseTags(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "no tags",
			input:    "Plain text response",
			expected: "Plain text response",
		},
		{
			name:     "with agent_response tags",
			input:    `<agent_response channel="cli">Wrapped response</agent_response>`,
			expected: "Wrapped response",
		},
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := StripResponseTags(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestExtractPrefix(t *testing.T) {
	assert.Equal(t, "cli", extractPrefix("cli:local"))
	assert.Equal(t, "discord", extractPrefix("discord:12345"))
	assert.Equal(t, "nocolon", extractPrefix("nocolon"))
}
