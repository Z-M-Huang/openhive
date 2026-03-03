package channel

import (
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/bwmarrin/discordgo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Mock DiscordSession ---

type mockDiscordSession struct {
	openCalled  bool
	closeCalled bool
	sent        []string
	openErr     error
	sendErr     error
	state       *discordgo.State
	handlers    []interface{}
}

func (m *mockDiscordSession) Open() error {
	m.openCalled = true
	return m.openErr
}

func (m *mockDiscordSession) Close() error {
	m.closeCalled = true
	return nil
}

func (m *mockDiscordSession) ChannelMessageSend(channelID string, content string, options ...discordgo.RequestOption) (*discordgo.Message, error) {
	if m.sendErr != nil {
		return nil, m.sendErr
	}
	m.sent = append(m.sent, content)
	return &discordgo.Message{ID: "msg-001"}, nil
}

func (m *mockDiscordSession) AddHandler(handler interface{}) func() {
	m.handlers = append(m.handlers, handler)
	return func() {}
}

func (m *mockDiscordSession) State() *discordgo.State {
	return m.state
}

// dispatchMessage calls the registered message-create handler as if a Discord event arrived.
func (m *mockDiscordSession) dispatchMessage(adapter *DiscordChannel, msg *discordgo.MessageCreate) {
	adapter.handleMessageCreate(nil, msg)
}

// --- Test helpers ---

func newTestDiscordChannel(mock *mockDiscordSession) *DiscordChannel {
	factory := func(token string) (DiscordSession, error) {
		return mock, nil
	}
	ch := NewDiscordChannel(
		DiscordConfig{Token: "test-token", ChannelID: "chan-001"},
		nil, // no eventBus needed for unit tests
		slog.Default(),
		factory,
	)
	return ch
}

// --- Tests ---

func TestDiscordConnect_OpensSessionAndRegistersHandler(t *testing.T) {
	mock := &mockDiscordSession{
		state: &discordgo.State{Ready: discordgo.Ready{User: &discordgo.User{ID: "bot-001"}}},
	}
	ch := newTestDiscordChannel(mock)

	err := ch.Connect()
	require.NoError(t, err)
	assert.True(t, mock.openCalled)
	assert.True(t, ch.IsConnected())
	assert.Equal(t, "bot-001", ch.botUserID)
	assert.NotEmpty(t, mock.handlers, "expected at least one handler registered")
}

func TestDiscordConnect_IdempotentWhenAlreadyConnected(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	require.NoError(t, ch.Connect())
	require.NoError(t, ch.Connect()) // second connect must not error
	assert.Equal(t, 1, countTrue(mock.openCalled), "Open should only be called once")
}

func countTrue(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestDiscordConnect_FactoryError(t *testing.T) {
	factory := func(token string) (DiscordSession, error) {
		return nil, fmt.Errorf("factory failure")
	}
	ch := NewDiscordChannel(DiscordConfig{Token: "bad", ChannelID: "c"}, nil, slog.Default(), factory)
	err := ch.Connect()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "factory failure")
}

func TestDiscordConnect_OpenError(t *testing.T) {
	mock := &mockDiscordSession{openErr: fmt.Errorf("open failed"), state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	err := ch.Connect()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "open failed")
	assert.False(t, ch.IsConnected())
}

func TestDiscordDisconnect_ClosesSession(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	err := ch.Disconnect()
	require.NoError(t, err)
	assert.True(t, mock.closeCalled)
	assert.False(t, ch.IsConnected())
}

func TestDiscordDisconnect_WhenNotConnected(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	err := ch.Disconnect()
	require.NoError(t, err)
	assert.False(t, mock.closeCalled)
}

func TestDiscordMessageHandler_FiltersBotMessages(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	msg := &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-001",
			Content:   "bot message",
			Author:    &discordgo.User{ID: "user-bot", Bot: true},
		},
	}
	mock.dispatchMessage(ch, msg)

	assert.Empty(t, received, "bot messages should be filtered")
}

func TestDiscordMessageHandler_FiltersWebhookMessages(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	msg := &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-001",
			Content:   "webhook message",
			Author:    &discordgo.User{ID: "wh-001", Bot: false},
			WebhookID: "webhook-001",
		},
	}
	mock.dispatchMessage(ch, msg)

	assert.Empty(t, received, "webhook messages should be filtered")
}

func TestDiscordMessageHandler_FiltersWrongChannel(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	msg := &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-WRONG",
			Content:   "wrong channel",
			Author:    &discordgo.User{ID: "user-001", Bot: false},
		},
	}
	mock.dispatchMessage(ch, msg)

	assert.Empty(t, received, "messages from wrong channel should be filtered")
}

func TestDiscordMessageHandler_FiltersSelfMessages(t *testing.T) {
	mock := &mockDiscordSession{
		state: &discordgo.State{Ready: discordgo.Ready{User: &discordgo.User{ID: "bot-001"}}},
	}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	msg := &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-001",
			Content:   "self message",
			Author:    &discordgo.User{ID: "bot-001", Bot: false},
		},
	}
	mock.dispatchMessage(ch, msg)

	assert.Empty(t, received, "self messages should be filtered")
}

func TestDiscordMessageHandler_CallsOnMessageForValidMessages(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)

	var receivedJID, receivedContent string
	ch.OnMessage(func(jid, content string) {
		receivedJID = jid
		receivedContent = content
	})

	msg := &discordgo.MessageCreate{
		Message: &discordgo.Message{
			ChannelID: "chan-001",
			Content:   "Hello bot!",
			Author:    &discordgo.User{ID: "user-001", Bot: false},
		},
	}
	mock.dispatchMessage(ch, msg)

	assert.Equal(t, "discord:chan-001:user-001", receivedJID)
	assert.Equal(t, "Hello bot!", receivedContent)
}

func TestDiscordSendMessage_ShortMessageSentAsIs(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	err := ch.SendMessage("discord:chan-001:user-001", "Short message")
	require.NoError(t, err)
	require.Len(t, mock.sent, 1)
	assert.Equal(t, "Short message", mock.sent[0])
}

func TestDiscordSendMessage_SplitsAtParagraphBoundary(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	// Create a message that's over 2000 chars with a paragraph break
	part1 := strings.Repeat("a", 1500) + "\n\n"
	part2 := strings.Repeat("b", 600)
	content := part1 + part2

	err := ch.SendMessage("discord:chan-001:user-001", content)
	require.NoError(t, err)
	assert.True(t, len(mock.sent) > 1, "expected message to be split")
	// Verify all content is preserved
	combined := strings.Join(mock.sent, "")
	assert.Equal(t, strings.ReplaceAll(strings.TrimSpace(content), "\n\n", ""), strings.ReplaceAll(combined, "\n\n", ""))
}

func TestDiscordSendMessage_SplitsAtSentenceBoundary(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	// Create a message that needs splitting, with sentence boundaries
	sentence := strings.Repeat("x", 1900) + ". " + strings.Repeat("y", 200)
	err := ch.SendMessage("discord:chan-001:user-001", sentence)
	require.NoError(t, err)
	assert.True(t, len(mock.sent) > 1, "expected message to be split into chunks")
}

func TestDiscordSendMessage_WhenNotConnected(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	// Do NOT connect

	err := ch.SendMessage("discord:chan-001:user-001", "test")
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestDiscordSendMessage_RateLimit(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	require.NoError(t, ch.Connect())

	// Send discordRateLimit messages in rapid succession
	for i := 0; i < discordRateLimit; i++ {
		require.NoError(t, ch.SendMessage("discord:chan-001:u", fmt.Sprintf("msg %d", i)))
	}

	// Next send should hit rate limit
	err := ch.SendMessage("discord:chan-001:u", "over limit")
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Contains(t, ve.Message, "rate limit")
}

func TestDiscordGetJIDPrefix(t *testing.T) {
	ch := NewDiscordChannel(DiscordConfig{}, nil, slog.Default(), nil)
	assert.Equal(t, "discord", ch.GetJIDPrefix())
}

// --- HandleConfigChange tests ---

func TestDiscordHandleConfigChange_EnabledToDisabled(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := newTestDiscordChannel(mock)
	ch.enabled = true
	require.NoError(t, ch.Connect())
	require.True(t, ch.IsConnected())

	// Disable via config change.
	ch.HandleConfigChange("test-token", "chan-001", false)

	assert.False(t, ch.IsConnected(), "channel should be disconnected after disable")
	assert.True(t, mock.closeCalled, "Close should have been called")
	assert.False(t, ch.enabled)
}

func TestDiscordHandleConfigChange_DisabledToEnabled(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := NewDiscordChannel(
		DiscordConfig{Token: "test-token", ChannelID: "chan-001", Enabled: false},
		nil,
		slog.Default(),
		func(token string) (DiscordSession, error) { return mock, nil },
	)
	require.False(t, ch.IsConnected())

	// Enable via config change.
	ch.HandleConfigChange("new-token", "chan-002", true)

	assert.True(t, ch.IsConnected(), "channel should be connected after enable")
	assert.True(t, mock.openCalled, "Open should have been called")
	assert.True(t, ch.enabled)

	// Verify new credentials were applied.
	ch.mu.RLock()
	tok := ch.token
	cid := ch.channelID
	ch.mu.RUnlock()
	assert.Equal(t, "new-token", tok)
	assert.Equal(t, "chan-002", cid)
}

func TestDiscordHandleConfigChange_CredentialsChangedWhileConnected(t *testing.T) {
	callCount := 0
	var createdSession *mockDiscordSession
	factory := func(token string) (DiscordSession, error) {
		callCount++
		createdSession = &mockDiscordSession{state: &discordgo.State{}}
		return createdSession, nil
	}
	ch := NewDiscordChannel(
		DiscordConfig{Token: "old-token", ChannelID: "chan-001", Enabled: true},
		nil,
		slog.Default(),
		factory,
	)
	require.NoError(t, ch.Connect())
	require.True(t, ch.IsConnected())

	prevSession := createdSession
	callsBefore := callCount

	// Change token while connected.
	ch.HandleConfigChange("new-token", "chan-001", true)

	assert.True(t, prevSession.closeCalled, "old session should be closed")
	assert.Greater(t, callCount, callsBefore, "factory should be called again for reconnect")
	assert.True(t, ch.IsConnected(), "channel should be reconnected")

	ch.mu.RLock()
	tok := ch.token
	ch.mu.RUnlock()
	assert.Equal(t, "new-token", tok)
}

func TestDiscordHandleConfigChange_NoChangeWhenStillDisabled(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := NewDiscordChannel(
		DiscordConfig{Token: "test-token", ChannelID: "chan-001", Enabled: false},
		nil,
		slog.Default(),
		func(token string) (DiscordSession, error) { return mock, nil },
	)

	// Should be a no-op.
	ch.HandleConfigChange("test-token", "chan-001", false)

	assert.False(t, ch.IsConnected())
	assert.False(t, mock.openCalled)
}

func TestDiscordHandleConfigChange_NoReconnectWhenNotConnected(t *testing.T) {
	mock := &mockDiscordSession{state: &discordgo.State{}}
	ch := NewDiscordChannel(
		DiscordConfig{Token: "old-token", ChannelID: "chan-001", Enabled: true},
		nil,
		slog.Default(),
		func(token string) (DiscordSession, error) { return mock, nil },
	)
	// enabled=true but never connected

	// Credentials changed but we were never connected — no reconnect.
	ch.HandleConfigChange("new-token", "chan-001", true)

	// Not connected, so no Disconnect/Connect cycle triggered (case falls to default).
	assert.False(t, ch.IsConnected())
	ch.mu.RLock()
	tok := ch.token
	ch.mu.RUnlock()
	assert.Equal(t, "new-token", tok)
}

func TestSplitMessage_ShortMessage(t *testing.T) {
	result := splitMessage("Hello world", 2000)
	require.Len(t, result, 1)
	assert.Equal(t, "Hello world", result[0])
}

func TestSplitMessage_ExactLength(t *testing.T) {
	content := strings.Repeat("a", 2000)
	result := splitMessage(content, 2000)
	require.Len(t, result, 1)
}

func TestSplitMessage_ParagraphSplit(t *testing.T) {
	part1 := strings.Repeat("a", 1500)
	part2 := strings.Repeat("b", 600)
	content := part1 + "\n\n" + part2
	result := splitMessage(content, 2000)
	assert.True(t, len(result) > 1)
	for _, chunk := range result {
		assert.LessOrEqual(t, len(chunk), 2000, "each chunk must be <=2000 chars")
	}
}

func TestSplitMessage_SentenceSplit(t *testing.T) {
	// 1900 'x' chars then ". " then 200 'y' chars — total > 2000
	content := strings.Repeat("x", 1900) + ". " + strings.Repeat("y", 200)
	result := splitMessage(content, 2000)
	assert.True(t, len(result) > 1)
	for _, chunk := range result {
		assert.LessOrEqual(t, len(chunk), 2000)
	}
}

func TestSplitMessage_WordSplit(t *testing.T) {
	// No paragraph or sentence boundary — falls back to word split
	words := make([]string, 300)
	for i := range words {
		words[i] = strings.Repeat("w", 7) // 7-char words
	}
	content := strings.Join(words, " ") // ~2400 chars
	result := splitMessage(content, 2000)
	assert.True(t, len(result) > 1)
	for _, chunk := range result {
		assert.LessOrEqual(t, len(chunk), 2000)
	}
}

func TestSplitMessage_HardSplit(t *testing.T) {
	// No spaces at all — hard split at maxLen
	content := strings.Repeat("a", 4500)
	result := splitMessage(content, 2000)
	assert.True(t, len(result) > 1)
	for _, chunk := range result {
		assert.LessOrEqual(t, len(chunk), 2000)
	}
}
