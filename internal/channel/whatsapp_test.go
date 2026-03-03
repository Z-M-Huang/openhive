package channel

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Mock WhatsAppClient ---

type mockWhatsAppClient struct {
	mu               sync.Mutex
	connectErr       error
	sendErr          error
	loggedIn         bool
	connectCalled    int
	disconnectCalled int
	sentMessages     []struct{ to types.JID; text string }
	eventHandlers    []func(interface{})
	qrChannel        chan QRChannelItem
	ownJID           types.JID
}

func (m *mockWhatsAppClient) Connect() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connectCalled++
	return m.connectErr
}

func (m *mockWhatsAppClient) Disconnect() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.disconnectCalled++
}

func (m *mockWhatsAppClient) getConnectCalled() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.connectCalled
}

func (m *mockWhatsAppClient) setConnectErr(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connectErr = err
}

func (m *mockWhatsAppClient) SendMessage(ctx context.Context, to types.JID, message *waE2E.Message) (interface{}, error) {
	if m.sendErr != nil {
		return nil, m.sendErr
	}
	m.sentMessages = append(m.sentMessages, struct{ to types.JID; text string }{to, message.GetConversation()})
	return nil, nil
}

func (m *mockWhatsAppClient) GetQRChannel(ctx context.Context) (<-chan QRChannelItem, error) {
	if m.qrChannel == nil {
		m.qrChannel = make(chan QRChannelItem, 1)
	}
	return m.qrChannel, nil
}

func (m *mockWhatsAppClient) IsConnected() bool { return m.connectCalled > 0 && m.connectErr == nil }
func (m *mockWhatsAppClient) IsLoggedIn() bool  { return m.loggedIn }
func (m *mockWhatsAppClient) GetOwnJID() types.JID { return m.ownJID }

func (m *mockWhatsAppClient) AddEventHandler(handler func(interface{})) uint32 {
	m.eventHandlers = append(m.eventHandlers, handler)
	return uint32(len(m.eventHandlers))
}

// dispatch calls all registered event handlers with the given event.
func (m *mockWhatsAppClient) dispatch(evt interface{}) {
	for _, h := range m.eventHandlers {
		h(evt)
	}
}

// --- Helpers ---

func newTestWhatsAppChannel(mock *mockWhatsAppClient) *WhatsAppChannel {
	factory := func(storePath string) (WhatsAppClient, error) {
		return mock, nil
	}
	return NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/test-wa"},
		slog.Default(),
		factory,
	)
}

func newTextMessage(phone, text string, fromMe bool) *events.Message {
	content := text
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:     types.NewJID(phone, types.DefaultUserServer),
				Sender:   types.NewJID(phone, types.DefaultUserServer),
				IsFromMe: fromMe,
			},
		},
		Message: &waE2E.Message{
			Conversation: &content,
		},
	}
}

// --- Tests ---

func TestWhatsAppConnect_WithExistingSession(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)

	err := ch.Connect()
	require.NoError(t, err)
	assert.True(t, ch.IsConnected())
	assert.Equal(t, 1, mock.connectCalled)
}

func TestWhatsAppConnect_WithoutSession_QRFlow(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: false}
	ch := newTestWhatsAppChannel(mock)

	var qrMu sync.Mutex
	var receivedQR string
	ch.OnMetadata(func(jid string, metadata map[string]string) {
		if code, ok := metadata["qr"]; ok {
			qrMu.Lock()
			receivedQR = code
			qrMu.Unlock()
		}
	})

	err := ch.Connect()
	require.NoError(t, err)
	assert.True(t, ch.IsConnected(), "channel should be connected (awaiting QR)")

	// Send a QR code from the channel
	mock.qrChannel <- QRChannelItem{Type: "code", Code: "test-qr-code-123"}
	close(mock.qrChannel)

	// Allow the goroutine to process
	time.Sleep(50 * time.Millisecond)
	qrMu.Lock()
	got := receivedQR
	qrMu.Unlock()
	assert.Equal(t, "test-qr-code-123", got)
}

func TestWhatsAppConnect_FactoryError(t *testing.T) {
	factory := func(storePath string) (WhatsAppClient, error) {
		return nil, fmt.Errorf("factory failure")
	}
	ch := NewWhatsAppChannel(WhatsAppConfig{}, slog.Default(), factory)
	err := ch.Connect()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "factory failure")
}

func TestWhatsAppConnect_NoFactory(t *testing.T) {
	ch := NewWhatsAppChannel(WhatsAppConfig{}, slog.Default(), nil)
	err := ch.Connect()
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestWhatsAppConnect_ConnectError(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true, connectErr: fmt.Errorf("dial failed")}
	ch := newTestWhatsAppChannel(mock)
	err := ch.Connect()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "dial failed")
	assert.False(t, ch.IsConnected())
}

func TestWhatsAppConnect_Idempotent(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)

	require.NoError(t, ch.Connect())
	require.NoError(t, ch.Connect()) // second call should no-op
	assert.Equal(t, 1, mock.connectCalled)
}

func TestWhatsAppDisconnect_ClosesCleanly(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	err := ch.Disconnect()
	require.NoError(t, err)
	assert.False(t, ch.IsConnected())
	assert.Equal(t, 1, mock.disconnectCalled)
}

func TestWhatsAppDisconnect_WhenNotConnected(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)

	err := ch.Disconnect()
	require.NoError(t, err)
	assert.Equal(t, 0, mock.disconnectCalled)
}

func TestWhatsAppEventHandler_FiltersProtocolMessages(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	// Send a message with empty Conversation (protocol/media-only)
	emptyContent := ""
	mock.dispatch(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Sender: types.NewJID("1234567890", types.DefaultUserServer),
			},
		},
		Message: &waE2E.Message{
			Conversation: &emptyContent,
		},
	})

	assert.Empty(t, received, "empty/protocol messages should be filtered")
}

func TestWhatsAppEventHandler_FiltersFromMeMessages(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	var received []string
	ch.OnMessage(func(jid, content string) { received = append(received, content) })

	mock.dispatch(newTextMessage("1234567890", "self message", true))
	assert.Empty(t, received, "self (IsFromMe) messages should be filtered")
}

func TestWhatsAppEventHandler_CallsOnMessageForTextMessages(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	var receivedJID, receivedContent string
	ch.OnMessage(func(jid, content string) {
		receivedJID = jid
		receivedContent = content
	})

	mock.dispatch(newTextMessage("441234567890", "Hello WhatsApp!", false))

	assert.Equal(t, "whatsapp:441234567890", receivedJID)
	assert.Equal(t, "Hello WhatsApp!", receivedContent)
}

func TestWhatsAppSendMessage_ValidatesLength(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	longMessage := make([]byte, whatsappMaxLen+1)
	for i := range longMessage {
		longMessage[i] = 'a'
	}
	err := ch.SendMessage("whatsapp:441234567890", string(longMessage))
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestWhatsAppSendMessage_SendsSuccessfully(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	err := ch.SendMessage("whatsapp:441234567890", "Hello!")
	require.NoError(t, err)
	require.Len(t, mock.sentMessages, 1)
	assert.Equal(t, "441234567890", mock.sentMessages[0].to.User)
	assert.Equal(t, "Hello!", mock.sentMessages[0].text)
}

func TestWhatsAppSendMessage_WhenNotConnected(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)

	err := ch.SendMessage("whatsapp:441234567890", "Hello!")
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestWhatsAppSendMessage_InvalidJID(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := newTestWhatsAppChannel(mock)
	require.NoError(t, ch.Connect())

	err := ch.SendMessage("discord:not-whatsapp", "Hello!")
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestWhatsAppReconnect_ExponentialBackoff(t *testing.T) {
	// Start connected (initial connect succeeds), then simulate a disconnect event
	// which triggers the reconnection loop.
	connectCount := 0
	var mock *mockWhatsAppClient
	mock = &mockWhatsAppClient{loggedIn: true}

	factory := func(storePath string) (WhatsAppClient, error) {
		return mock, nil
	}
	ch := NewWhatsAppChannel(WhatsAppConfig{}, slog.Default(), factory)

	// Initial connect succeeds
	require.NoError(t, ch.Connect())
	connectCount = mock.getConnectCalled()

	// Simulate a disconnect event — this triggers reconnectLoop()
	// First few reconnects will fail, then succeed
	mock.setConnectErr(fmt.Errorf("network error"))
	go func() {
		time.Sleep(20 * time.Millisecond)
		// Clear error after a few attempts
		mock.setConnectErr(nil)
	}()

	// Manually trigger the reconnect loop (simulating a disconnect event)
	go ch.reconnectLoop()

	// Wait up to 2 seconds for at least one reconnect attempt
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mock.getConnectCalled() > connectCount {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	assert.Greater(t, mock.getConnectCalled(), connectCount, "reconnect loop should attempt at least one reconnect")
}

func TestWhatsAppGetJIDPrefix(t *testing.T) {
	ch := NewWhatsAppChannel(WhatsAppConfig{}, slog.Default(), nil)
	assert.Equal(t, "whatsapp", ch.GetJIDPrefix())
}

// --- HandleConfigChange tests ---

func TestWhatsAppHandleConfigChange_EnabledToDisabled(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/wa", Enabled: true},
		slog.Default(),
		func(storePath string) (WhatsAppClient, error) { return mock, nil },
	)
	require.NoError(t, ch.Connect())
	require.True(t, ch.IsConnected())

	ch.HandleConfigChange("/tmp/wa", false)

	assert.False(t, ch.IsConnected(), "channel should be disconnected after disable")
	assert.Equal(t, 1, mock.disconnectCalled)
	ch.mu.RLock()
	enabled := ch.enabled
	ch.mu.RUnlock()
	assert.False(t, enabled)
}

func TestWhatsAppHandleConfigChange_DisabledToEnabled(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/wa", Enabled: false},
		slog.Default(),
		func(storePath string) (WhatsAppClient, error) { return mock, nil },
	)
	require.False(t, ch.IsConnected())

	ch.HandleConfigChange("/tmp/wa-new", true)

	assert.True(t, ch.IsConnected(), "channel should be connected after enable")
	assert.Equal(t, 1, mock.connectCalled)
	ch.mu.RLock()
	sp := ch.storePath
	enabled := ch.enabled
	ch.mu.RUnlock()
	assert.Equal(t, "/tmp/wa-new", sp)
	assert.True(t, enabled)
}

func TestWhatsAppHandleConfigChange_StorePathChangedWhileConnected(t *testing.T) {
	connectCount := 0
	disconnectCount := 0

	mock1 := &mockWhatsAppClient{loggedIn: true}
	mock2 := &mockWhatsAppClient{loggedIn: true}
	mocks := []*mockWhatsAppClient{mock1, mock2}

	factory := func(storePath string) (WhatsAppClient, error) {
		m := mocks[connectCount]
		connectCount++
		return m, nil
	}

	ch := NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/wa-old", Enabled: true},
		slog.Default(),
		factory,
	)
	require.NoError(t, ch.Connect())
	require.True(t, ch.IsConnected())
	disconnectCount = mock1.disconnectCalled

	// Change store path while connected.
	ch.HandleConfigChange("/tmp/wa-new", true)

	assert.Equal(t, disconnectCount+1, mock1.disconnectCalled, "old client should be disconnected")
	assert.True(t, ch.IsConnected(), "channel should be reconnected")
	ch.mu.RLock()
	sp := ch.storePath
	ch.mu.RUnlock()
	assert.Equal(t, "/tmp/wa-new", sp)
}

func TestWhatsAppHandleConfigChange_NoChangeWhenStillDisabled(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/wa", Enabled: false},
		slog.Default(),
		func(storePath string) (WhatsAppClient, error) { return mock, nil },
	)

	// Should be a no-op (still disabled).
	ch.HandleConfigChange("/tmp/wa", false)

	assert.False(t, ch.IsConnected())
	assert.Equal(t, 0, mock.connectCalled)
}

func TestWhatsAppHandleConfigChange_NoReconnectWhenNotConnected(t *testing.T) {
	mock := &mockWhatsAppClient{loggedIn: true}
	ch := NewWhatsAppChannel(
		WhatsAppConfig{StorePath: "/tmp/wa-old", Enabled: true},
		slog.Default(),
		func(storePath string) (WhatsAppClient, error) { return mock, nil },
	)
	// enabled=true but never connected

	// Store path changed but not connected — no reconnect (default branch).
	ch.HandleConfigChange("/tmp/wa-new", true)

	assert.False(t, ch.IsConnected())
	ch.mu.RLock()
	sp := ch.storePath
	ch.mu.RUnlock()
	assert.Equal(t, "/tmp/wa-new", sp)
}

func TestExtractWhatsAppPhone(t *testing.T) {
	tests := []struct {
		jid      string
		expected string
	}{
		{"whatsapp:441234567890", "441234567890"},
		{"whatsapp:1234", "1234"},
		{"discord:123:456", ""},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.jid, func(t *testing.T) {
			assert.Equal(t, tt.expected, extractWhatsAppPhone(tt.jid))
		})
	}
}
