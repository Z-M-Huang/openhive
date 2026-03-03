package integration

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/channel"
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/crypto"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/bwmarrin/discordgo"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// phase3Setup builds the in-memory infrastructure for Phase 3 tests.
type phase3Setup struct {
	db           *store.DB
	taskStore    *store.TaskStoreImpl
	sessionStore *store.SessionStoreImpl
	messageStore *store.MessageStoreImpl
	wsHub        *ws.Hub
	router       *channel.Router
	logger       *slog.Logger
}

func newPhase3Setup(t *testing.T) *phase3Setup {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))

	// Each test gets an isolated in-memory database by using the test name as a unique cache key.
	db, err := store.NewDB("file:phase3_" + t.Name() + "?mode=memory&cache=shared")
	require.NoError(t, err)

	taskStore := store.NewTaskStore(db)
	sessionStore := store.NewSessionStore(db)
	messageStore := store.NewMessageStore(db)

	wsHub := ws.NewHub(logger)

	router := channel.NewRouter(channel.RouterConfig{
		WSHub:            wsHub,
		TaskStore:        taskStore,
		SessionStore:     sessionStore,
		MessageStore:     messageStore,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
	})

	return &phase3Setup{
		db:           db,
		taskStore:    taskStore,
		sessionStore: sessionStore,
		messageStore: messageStore,
		wsHub:        wsHub,
		router:       router,
		logger:       logger,
	}
}

// --- Tests ---

func TestPhase3_EndToEndChannelFlow(t *testing.T) {
	s := newPhase3Setup(t)
	ctx := context.Background()

	// Register a mock channel adapter
	mock := &mockChannelAdapter{prefix: "test"}
	require.NoError(t, s.router.RegisterChannel(mock))

	// Simulate an inbound message
	require.NoError(t, s.router.RouteInbound("test:user-001", "Hello from Phase 3"))

	// Verify task was created in the store
	tasks, err := s.taskStore.ListByTeam(ctx, "main")
	require.NoError(t, err)
	require.Len(t, tasks, 1)

	task := tasks[0]
	assert.Equal(t, domain.TaskStatusPending, task.Status)
	assert.Equal(t, "test:user-001", task.JID)
	assert.Contains(t, task.Prompt, "Hello from Phase 3")
	assert.Contains(t, task.Prompt, `<user_message`)

	// Verify inbound message was persisted
	messages, err := s.messageStore.GetLatest(ctx, "test:user-001", 10)
	require.NoError(t, err)
	require.Len(t, messages, 1)
	assert.Equal(t, "user", messages[0].Role)
	assert.Equal(t, "Hello from Phase 3", messages[0].Content)
}

func TestPhase3_EndToEndOutboundFlow(t *testing.T) {
	s := newPhase3Setup(t)

	// Register a mock channel adapter
	mock := &mockChannelAdapter{prefix: "test"}
	require.NoError(t, s.router.RegisterChannel(mock))

	// Simulate an inbound message first (to create a task)
	require.NoError(t, s.router.RouteInbound("test:user-001", "Hello"))

	// Get the task that was created
	ctx := context.Background()
	tasks, err := s.taskStore.ListByTeam(ctx, "main")
	require.NoError(t, err)
	require.Len(t, tasks, 1)

	// Simulate a task result coming back
	result := &ws.TaskResultMsg{
		TaskID: tasks[0].ID,
		Status: "completed",
		Result: "Hi there! I'm the assistant.",
	}
	require.NoError(t, s.router.HandleTaskResult(ctx, result))

	// Verify outbound message was sent to the channel
	assert.Equal(t, []string{"Hi there! I'm the assistant."}, mock.sentMessages)

	// Verify outbound message was persisted
	messages, err := s.messageStore.GetLatest(ctx, "test:user-001", 10)
	require.NoError(t, err)
	found := false
	for _, msg := range messages {
		if msg.Role == "assistant" {
			found = true
			assert.Equal(t, "Hi there! I'm the assistant.", msg.Content)
		}
	}
	assert.True(t, found, "assistant message should be persisted")
}

func TestPhase3_DiscordAdapter(t *testing.T) {
	s := newPhase3Setup(t)

	mockSession := &mockDiscordSessionPhase3{
		state: &discordgo.State{Ready: discordgo.Ready{User: &discordgo.User{ID: "bot-001"}}},
	}

	factory := func(token string) (channel.DiscordSession, error) {
		return mockSession, nil
	}

	discordCh := channel.NewDiscordChannel(
		channel.DiscordConfig{Token: "test-token", ChannelID: "chan-001"},
		nil,
		s.logger,
		factory,
	)

	require.NoError(t, s.router.RegisterChannel(discordCh))
	require.NoError(t, discordCh.Connect())

	// Simulate a message from Discord
	var receivedJID, receivedContent string
	discordCh.OnMessage(func(jid, content string) {
		receivedJID = jid
		receivedContent = content
	})

	// Dispatch a message through the discord handler
	discordCh.HandleMessageCreateForTest(nil, &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-001",
			Content:   "Test Discord message",
			Author:    &discordgo.User{ID: "user-discord-001", Bot: false},
		},
	})

	assert.Equal(t, "discord:chan-001:user-discord-001", receivedJID)
	assert.Equal(t, "Test Discord message", receivedContent)

	// Test message splitting
	longMsg := strings.Repeat("a", 2100)
	require.NoError(t, discordCh.SendMessage("discord:chan-001:user-001", longMsg))
	assert.True(t, len(mockSession.sent) > 1, "long message should be split")
	for _, chunk := range mockSession.sent {
		assert.LessOrEqual(t, len(chunk), 2000)
	}
}

func TestPhase3_WhatsAppAdapter(t *testing.T) {
	s := newPhase3Setup(t)

	mockWA := &mockWAClientPhase3{loggedIn: true}
	factory := func(storePath string) (channel.WhatsAppClient, error) {
		return mockWA, nil
	}

	waCh := channel.NewWhatsAppChannel(
		channel.WhatsAppConfig{StorePath: "/tmp/test-wa"},
		s.logger,
		factory,
	)

	require.NoError(t, s.router.RegisterChannel(waCh))
	require.NoError(t, waCh.Connect())

	// Register message callback (normally done by RegisterChannel)
	var receivedJID, receivedContent string
	waCh.OnMessage(func(jid, content string) {
		receivedJID = jid
		receivedContent = content
	})

	// Simulate a text message event
	textContent := "Hello from WhatsApp"
	mockWA.dispatch(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Sender: types.NewJID("441234567890", types.DefaultUserServer),
			},
		},
		Message: &waE2E.Message{
			Conversation: &textContent,
		},
	})

	assert.Equal(t, "whatsapp:441234567890", receivedJID)
	assert.Equal(t, "Hello from WhatsApp", receivedContent)
}

func TestPhase3_CrashRecovery(t *testing.T) {
	s := newPhase3Setup(t)
	ctx := context.Background()

	// Create a session with lastTimestamp > lastAgentTimestamp (simulates in-flight)
	now := time.Now()
	session := &domain.ChatSession{
		ChatJID:            "test:user-crash",
		ChannelType:        "test",
		LastTimestamp:      now,
		LastAgentTimestamp: now.Add(-5 * time.Minute), // agent is 5 min behind
		AgentAID:           "aid-main-001",
	}
	require.NoError(t, s.sessionStore.Upsert(ctx, session))

	// Create a matching pending task
	task := &domain.Task{
		ID:        "task-crash-001",
		TeamSlug:  "main",
		AgentAID:  "aid-main-001",
		JID:       "test:user-crash",
		Status:    domain.TaskStatusPending,
		Prompt:    `<user_message channel="test">recover me</user_message>`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	require.NoError(t, s.taskStore.Create(ctx, task))

	// Trigger recovery
	wsDispatchCount := 0
	s.wsHub.SetOnMessage(func(teamID string, msg []byte) {
		wsDispatchCount++
	})

	err := s.router.RecoverInFlight(ctx)
	require.NoError(t, err)
	// Recovery attempts to send to "main" team but no WS connection exists — that's okay
}

func TestPhase3_TokenEncryption(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(dir+"/providers.yaml", []byte("providers:\n  default:\n    name: default\n    type: oauth\n    oauth_token: test-token\n"), 0600))
	yamlContent := `
system:
  listen_address: "127.0.0.1:8080"
  data_dir: "` + dir + `"
  log_level: "info"
assistant:
  name: "Test"
  aid: "aid-test-001"
  provider: "default"
  model_tier: "sonnet"
  max_turns: 50
  timeout_minutes: 10
channels:
  discord:
    enabled: false
    token: "plaintext-test-token"
  whatsapp:
    enabled: false
`
	require.NoError(t, os.WriteFile(dir+"/openhive.yaml", []byte(yamlContent), 0600))

	km := crypto.NewManager()
	require.NoError(t, km.Unlock("test-master-key-16chars"))

	loader, err := config.NewLoader(dir, dir)
	require.NoError(t, err)
	loader.SetKeyManager(km)

	cfg, err := loader.LoadMaster()
	require.NoError(t, err)

	assert.True(t, strings.HasPrefix(cfg.Channels.Discord.Token, "enc:"),
		"plaintext token should be auto-encrypted on load")
}

// --- Mock helpers for Phase 3 integration tests ---

// mockChannelAdapter is a simple in-memory channel adapter for testing.
type mockChannelAdapter struct {
	prefix       string
	sentMessages []string
	onMessage    func(jid string, content string)
}

func (m *mockChannelAdapter) Connect() error    { return nil }
func (m *mockChannelAdapter) Disconnect() error { return nil }
func (m *mockChannelAdapter) GetJIDPrefix() string { return m.prefix }
func (m *mockChannelAdapter) IsConnected() bool    { return true }
func (m *mockChannelAdapter) OnMessage(callback func(jid string, content string)) {
	m.onMessage = callback
}
func (m *mockChannelAdapter) OnMetadata(callback func(jid string, metadata map[string]string)) {}
func (m *mockChannelAdapter) SendMessage(jid string, content string) error {
	m.sentMessages = append(m.sentMessages, content)
	return nil
}

// mockDiscordSessionPhase3 is a test mock for discordgo.Session.
type mockDiscordSessionPhase3 struct {
	sent  []string
	state *discordgo.State
}

func (m *mockDiscordSessionPhase3) Open() error  { return nil }
func (m *mockDiscordSessionPhase3) Close() error { return nil }
func (m *mockDiscordSessionPhase3) ChannelMessageSend(channelID, content string, opts ...discordgo.RequestOption) (*discordgo.Message, error) {
	m.sent = append(m.sent, content)
	return &discordgo.Message{}, nil
}
func (m *mockDiscordSessionPhase3) AddHandler(handler interface{}) func() { return func() {} }
func (m *mockDiscordSessionPhase3) State() *discordgo.State               { return m.state }

// mockWAClientPhase3 is a test mock for the WhatsApp client.
type mockWAClientPhase3 struct {
	loggedIn      bool
	connectCalled int
	handlers      []func(interface{})
}

func (m *mockWAClientPhase3) Connect() error { m.connectCalled++; return nil }
func (m *mockWAClientPhase3) Disconnect()    {}
func (m *mockWAClientPhase3) SendMessage(ctx context.Context, to types.JID, msg *waE2E.Message) (interface{}, error) {
	return nil, nil
}
func (m *mockWAClientPhase3) GetQRChannel(ctx context.Context) (<-chan channel.QRChannelItem, error) {
	ch := make(chan channel.QRChannelItem)
	close(ch)
	return ch, nil
}
func (m *mockWAClientPhase3) IsConnected() bool { return m.connectCalled > 0 }
func (m *mockWAClientPhase3) IsLoggedIn() bool  { return m.loggedIn }
func (m *mockWAClientPhase3) GetOwnJID() types.JID {
	return types.NewJID("bot", types.DefaultUserServer)
}
func (m *mockWAClientPhase3) AddEventHandler(handler func(interface{})) uint32 {
	m.handlers = append(m.handlers, handler)
	return uint32(len(m.handlers))
}
func (m *mockWAClientPhase3) dispatch(evt interface{}) {
	for _, h := range m.handlers {
		h(evt)
	}
}
