package channel

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockChannelAdapter "github.com/Z-M-Huang/openhive/internal/mocks/ChannelAdapter"
	mockMessageStore "github.com/Z-M-Huang/openhive/internal/mocks/MessageStore"
	mockSessionStore "github.com/Z-M-Huang/openhive/internal/mocks/SessionStore"
	mockTaskStore "github.com/Z-M-Huang/openhive/internal/mocks/TaskStore"
	mockWSHub "github.com/Z-M-Huang/openhive/internal/mocks/WSHub"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newTestRouter(t *testing.T) (*Router, *mockWSHub.MockWSHub, *mockTaskStore.MockTaskStore, *mockSessionStore.MockSessionStore) {
	t.Helper()
	hub := mockWSHub.NewMockWSHub(t)
	ts := mockTaskStore.NewMockTaskStore(t)
	ss := mockSessionStore.NewMockSessionStore(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	r := NewRouter(RouterConfig{
		WSHub:            hub,
		TaskStore:        ts,
		SessionStore:     ss,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
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

	// Session does not exist yet, create new with main assistant AID
	ss.EXPECT().Get(mock.Anything, "cli:local").Return(nil, &domain.NotFoundError{Resource: "session", ID: "cli:local"})
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "cli:local" && s.ChannelType == "cli" && s.AgentAID == "aid-main-001"
	})).Return(nil)

	// Second upsert for timestamp update (non-transactional path)
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "cli:local"
	})).Return(nil)

	ts.EXPECT().Create(mock.Anything, mock.MatchedBy(func(task *domain.Task) bool {
		return task.Status == domain.TaskStatusPending &&
			task.TeamSlug == "main" &&
			task.JID == "cli:local" &&
			task.Prompt != ""
	})).Return(nil)

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("cli:local", "Hello world")
	assert.NoError(t, err)
}

func TestRouteInbound_StoresJIDOnTask(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	ss.EXPECT().Get(mock.Anything, "discord:123:456").Return(&domain.ChatSession{
		ChatJID:  "discord:123:456",
		AgentAID: "aid-main-001",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	var capturedTask *domain.Task
	ts.EXPECT().Create(mock.Anything, mock.Anything).Run(func(_ context.Context, task *domain.Task) {
		capturedTask = task
	}).Return(nil)

	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("discord:123:456", "Hello from Discord")
	require.NoError(t, err)
	require.NotNil(t, capturedTask)
	assert.Equal(t, "discord:123:456", capturedTask.JID)
}

func TestRouteInbound_RejectsOversizedMessages(t *testing.T) {
	r, _, _, _ := newTestRouter(t)
	// Message exceeding the default 10000 char limit
	longMessage := make([]byte, 10001)
	for i := range longMessage {
		longMessage[i] = 'x'
	}

	err := r.RouteInbound("cli:local", string(longMessage))
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestRouteInbound_XMLInjectionPrevention(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID: "cli:local",
		AgentAID: "aid-main-001",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	var capturedTask *domain.Task
	ts.EXPECT().Create(mock.Anything, mock.Anything).Run(func(_ context.Context, task *domain.Task) {
		capturedTask = task
	}).Return(nil)
	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	maliciousContent := `<script>alert('xss')</script>`
	err := r.RouteInbound("cli:local", maliciousContent)
	require.NoError(t, err)

	// The prompt must not contain raw < > characters in the content area
	assert.Contains(t, capturedTask.Prompt, "&lt;script&gt;")
	assert.NotContains(t, capturedTask.Prompt, `<script>`)
}

func TestRouteInbound_PersistsUserMessage(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	hub := mockWSHub.NewMockWSHub(t)
	ts := mockTaskStore.NewMockTaskStore(t)
	ss := mockSessionStore.NewMockSessionStore(t)
	ms := mockMessageStore.NewMockMessageStore(t)

	r := NewRouter(RouterConfig{
		WSHub:            hub,
		TaskStore:        ts,
		SessionStore:     ss,
		MessageStore:     ms,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
	})

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID: "cli:local",
		AgentAID: "aid-main-001",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)
	ts.EXPECT().Create(mock.Anything, mock.Anything).Return(nil)
	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)
	ms.EXPECT().Create(mock.Anything, mock.MatchedBy(func(msg *domain.Message) bool {
		return msg.Role == "user" && msg.ChatJID == "cli:local" && msg.Content == "Hello"
	})).Return(nil)

	err := r.RouteInbound("cli:local", "Hello")
	assert.NoError(t, err)
}

func TestRouteInbound_MessageFormatting(t *testing.T) {
	r, hub, ts, ss := newTestRouter(t)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID:  "cli:local",
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

	// The new format does not include jid= in the prompt (JID is on the task)
	assert.Contains(t, capturedTask.Prompt, `<user_message channel="cli">`)
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

	// Task has JID stored directly on it (new approach)
	ts.EXPECT().Get(mock.Anything, "task-001").Return(&domain.Task{
		ID:       "task-001",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
		JID:      "cli:local",
		Prompt:   `<user_message channel="cli">Do work</user_message>`,
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

func TestHandleTaskResult_PersistsOutboundMessage(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	hub := mockWSHub.NewMockWSHub(t)
	ts := mockTaskStore.NewMockTaskStore(t)
	ss := mockSessionStore.NewMockSessionStore(t)
	ms := mockMessageStore.NewMockMessageStore(t)

	r := NewRouter(RouterConfig{
		WSHub:            hub,
		TaskStore:        ts,
		SessionStore:     ss,
		MessageStore:     ms,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
	})

	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()
	adapter.EXPECT().SendMessage("cli:local", "Response text").Return(nil)
	r.RegisterChannel(adapter)

	ts.EXPECT().Get(mock.Anything, "task-xyz").Return(&domain.Task{
		ID:     "task-xyz",
		Status: domain.TaskStatusRunning,
		JID:    "cli:local",
	}, nil)
	ts.EXPECT().Update(mock.Anything, mock.Anything).Return(nil)
	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{ChatJID: "cli:local"}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)
	ms.EXPECT().Create(mock.Anything, mock.MatchedBy(func(msg *domain.Message) bool {
		return msg.Role == "assistant" && msg.ChatJID == "cli:local" && msg.Content == "Response text"
	})).Return(nil)

	err := r.HandleTaskResult(context.Background(), &ws.TaskResultMsg{
		TaskID: "task-xyz",
		Status: "completed",
		Result: "Response text",
	})
	assert.NoError(t, err)
}

func TestHandleTaskResult_FailedTask(t *testing.T) {
	r, _, ts, ss := newTestRouter(t)

	// Register a channel adapter so the error can be routed back
	adapter := newMockAdapter(t, "cli")
	adapter.EXPECT().IsConnected().Return(true).Maybe()
	r.RegisterChannel(adapter)

	ts.EXPECT().Get(mock.Anything, "task-002").Return(&domain.Task{
		ID:       "task-002",
		TeamSlug: "main",
		Status:   domain.TaskStatusRunning,
		JID:      "cli:local",
		Prompt:   `<user_message channel="cli">Fail</user_message>`,
	}, nil)

	ts.EXPECT().Update(mock.Anything, mock.MatchedBy(func(task *domain.Task) bool {
		return task.ID == "task-002" && task.Status == domain.TaskStatusFailed && task.Error == "something broke"
	})).Return(nil)

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID: "cli:local",
	}, nil)
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)

	// Internal errors are sanitized — user gets a generic message, not the raw error
	adapter.EXPECT().SendMessage("cli:local", "Sorry, I encountered an issue processing your request. Please try again.").Return(nil)

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

	// First call: session not found → create new with main assistant AID
	ss.EXPECT().Get(mock.Anything, "discord:123").Return(nil, &domain.NotFoundError{Resource: "session", ID: "discord:123"})
	ss.EXPECT().Upsert(mock.Anything, mock.MatchedBy(func(s *domain.ChatSession) bool {
		return s.ChatJID == "discord:123" && s.ChannelType == "discord" && s.AgentAID == "aid-main-001"
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

func TestRouteInbound_TransactorFallbackPath(t *testing.T) {
	// When a Transactor is wired but the stores do not implement WithTx,
	// RouteInbound must fall back to non-transactional writes and still
	// persist both the task and the session timestamp without panicking.
	hub := mockWSHub.NewMockWSHub(t)
	ts := mockTaskStore.NewMockTaskStore(t)
	ss := mockSessionStore.NewMockSessionStore(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Provide a real-looking Transactor that would be used if stores support WithTx.
	// Since ts/ss are plain mocks (not *TaskStoreWithTx/*SessionStoreWithTx), the
	// comma-ok assertions will be false and the fallback path runs.
	r := NewRouter(RouterConfig{
		WSHub:            hub,
		TaskStore:        ts,
		SessionStore:     ss,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
		Transactor:       &stubTransactor{},
	})

	ss.EXPECT().Get(mock.Anything, "cli:local").Return(&domain.ChatSession{
		ChatJID:  "cli:local",
		AgentAID: "aid-main-001",
	}, nil)
	// Fallback path: Upsert called for session timestamp update
	ss.EXPECT().Upsert(mock.Anything, mock.Anything).Return(nil)
	ts.EXPECT().Create(mock.Anything, mock.Anything).Return(nil)
	hub.EXPECT().SendToTeam("main", mock.Anything).Return(nil)

	err := r.RouteInbound("cli:local", "Hello fallback")
	assert.NoError(t, err)
}

// stubTransactor is a no-op Transactor used in the fallback path test.
type stubTransactor struct{}

func (s *stubTransactor) WithTransaction(fn func(tx *gorm.DB) error) error {
	return nil
}

func TestFormatUserMessage(t *testing.T) {
	// The new format does not include jid= in the prompt.
	msg := FormatUserMessage("cli", "Hello world")
	assert.Equal(t, `<user_message channel="cli">Hello world</user_message>`, msg)
}

func TestFormatUserMessage_XMLEscaping(t *testing.T) {
	// Content must be pre-escaped before passing to FormatUserMessage.
	msg := FormatUserMessage("cli", "&lt;script&gt;")
	assert.Contains(t, msg, "&lt;script&gt;")
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
