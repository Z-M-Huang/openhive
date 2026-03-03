package channel

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

const (
	whatsappPrefix      = "whatsapp"
	whatsappMaxLen      = 4096
	waBackoffBase       = time.Second
	waBackoffMax        = 60 * time.Second
	waBackoffMultiplier = 2
)

// WhatsAppClient is an interface wrapping the whatsmeow.Client methods we need.
// This allows injection of a mock in tests.
type WhatsAppClient interface {
	Connect() error
	Disconnect()
	SendMessage(ctx context.Context, to types.JID, message *waE2E.Message) (interface{}, error)
	GetQRChannel(ctx context.Context) (<-chan QRChannelItem, error)
	IsConnected() bool
	AddEventHandler(handler func(interface{})) uint32
	IsLoggedIn() bool
	GetOwnJID() types.JID
}

// QRChannelItem represents a single item from the QR code channel.
type QRChannelItem struct {
	// Code is the QR code string (valid when Type == "code").
	Code string
	// Type is "code" for new QR codes or "error" for pairing failures.
	Type string
	// Error holds the error if Type == "error".
	Error error
}

// WhatsAppConfig holds the configuration for the WhatsApp channel.
type WhatsAppConfig struct {
	StorePath string
	Enabled   bool
}

// WhatsAppClientFactory creates a WhatsAppClient given a store path.
// Overridable in tests.
type WhatsAppClientFactory func(storePath string) (WhatsAppClient, error)

// WhatsAppChannel implements domain.ChannelAdapter for WhatsApp via whatsmeow.
type WhatsAppChannel struct {
	storePath  string
	enabled    bool
	factory    WhatsAppClientFactory
	logger     *slog.Logger
	client     WhatsAppClient
	onMessage  func(jid string, content string)
	onMetadata func(jid string, metadata map[string]string)
	mu         sync.RWMutex
	connected  bool
	stopReconn chan struct{}
}

// NewWhatsAppChannel creates a new WhatsApp channel adapter.
// factory may be nil; callers must call Connect() before use.
func NewWhatsAppChannel(cfg WhatsAppConfig, logger *slog.Logger, factory WhatsAppClientFactory) *WhatsAppChannel {
	return &WhatsAppChannel{
		storePath:  cfg.StorePath,
		enabled:    cfg.Enabled,
		factory:    factory,
		logger:     logger,
		stopReconn: make(chan struct{}),
	}
}

// HandleConfigChange reacts to a MasterConfig change event.
// It compares the new WhatsApp channel config to the current state and
// connects, disconnects, or reconnects as needed.
func (w *WhatsAppChannel) HandleConfigChange(newStorePath string, newEnabled bool) {
	w.mu.RLock()
	oldEnabled := w.enabled
	oldStorePath := w.storePath
	wasConnected := w.connected
	w.mu.RUnlock()

	switch {
	case oldEnabled && !newEnabled:
		// Was enabled, now disabled: disconnect.
		w.logger.Info("whatsapp: config changed — disabling channel")
		if err := w.Disconnect(); err != nil {
			w.logger.Warn("whatsapp: disconnect on disable failed", "error", err)
		}
		w.mu.Lock()
		w.enabled = false
		w.mu.Unlock()

	case !oldEnabled && newEnabled:
		// Was disabled, now enabled: update store path and connect.
		w.logger.Info("whatsapp: config changed — enabling channel")
		w.mu.Lock()
		w.storePath = newStorePath
		w.enabled = true
		// Reset the stop channel so reconnect loop can work.
		w.stopReconn = make(chan struct{})
		w.mu.Unlock()
		if err := w.Connect(); err != nil {
			w.logger.Warn("whatsapp: connect on enable failed", "error", err)
		}

	case newEnabled && wasConnected && newStorePath != oldStorePath:
		// Store path changed while connected: reconnect with new store path.
		w.logger.Info("whatsapp: config changed — reconnecting with new store path")
		if err := w.Disconnect(); err != nil {
			w.logger.Warn("whatsapp: disconnect before store path update failed", "error", err)
		}
		w.mu.Lock()
		w.storePath = newStorePath
		w.enabled = true
		// Reset the stop channel so the new connection can use it.
		w.stopReconn = make(chan struct{})
		w.mu.Unlock()
		if err := w.Connect(); err != nil {
			w.logger.Warn("whatsapp: reconnect after store path update failed", "error", err)
		}

	default:
		// No actionable change (e.g. still disabled, or enabled+connected with same store path).
		w.mu.Lock()
		w.storePath = newStorePath
		w.enabled = newEnabled
		w.mu.Unlock()
	}
}

// Connect opens the WhatsApp client. If no existing session is found it emits a
// QR code via the OnMetadata callback. On connection loss it starts an exponential
// backoff reconnection loop.
func (w *WhatsAppChannel) Connect() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.connected {
		return nil
	}

	if w.factory == nil {
		return &domain.ValidationError{Field: "factory", Message: "whatsapp client factory is not configured"}
	}

	client, err := w.factory(w.storePath)
	if err != nil {
		return fmt.Errorf("whatsapp connect: failed to create client: %w", err)
	}
	w.client = client

	// Register event handler before connecting.
	client.AddEventHandler(w.handleEvent)

	if !client.IsLoggedIn() {
		// Need QR code authentication.
		ctx := context.Background()
		qrCh, err := client.GetQRChannel(ctx)
		if err != nil {
			return fmt.Errorf("whatsapp connect: failed to get QR channel: %w", err)
		}

		// Connect in background — required before QR codes start arriving.
		go func() {
			if connErr := client.Connect(); connErr != nil {
				w.logger.Error("whatsapp: connection error during QR auth", "error", connErr)
			}
		}()

		// Relay QR codes to the metadata callback.
		go w.relayQRCodes(qrCh)
		w.connected = true
		return nil
	}

	if err := client.Connect(); err != nil {
		return fmt.Errorf("whatsapp connect: %w", err)
	}

	w.connected = true
	w.logger.Info("whatsapp channel connected")
	return nil
}

// Disconnect cleanly closes the WhatsApp client.
func (w *WhatsAppChannel) Disconnect() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.connected {
		return nil
	}

	// Signal reconnection loop to stop.
	select {
	case <-w.stopReconn:
	default:
		close(w.stopReconn)
	}

	if w.client != nil {
		w.client.Disconnect()
	}
	w.connected = false
	w.logger.Info("whatsapp channel disconnected")
	return nil
}

// SendMessage sends a text message to the given JID.
// JID format: "whatsapp:<phone>" — the phone number is extracted and used as the WhatsApp JID.
func (w *WhatsAppChannel) SendMessage(jid string, content string) error {
	if len(content) > whatsappMaxLen {
		return &domain.ValidationError{
			Field:   "content",
			Message: fmt.Sprintf("message exceeds maximum length of %d characters", whatsappMaxLen),
		}
	}

	w.mu.RLock()
	client := w.client
	connected := w.connected
	w.mu.RUnlock()

	if !connected || client == nil {
		return &domain.ValidationError{Field: "connection", Message: "whatsapp channel is not connected"}
	}

	phone := extractWhatsAppPhone(jid)
	if phone == "" {
		return &domain.ValidationError{Field: "jid", Message: fmt.Sprintf("invalid whatsapp JID: %s", jid)}
	}

	recipient := types.NewJID(phone, types.DefaultUserServer)
	msg := &waE2E.Message{
		Conversation: &content,
	}

	ctx := context.Background()
	if _, err := client.SendMessage(ctx, recipient, msg); err != nil {
		return fmt.Errorf("whatsapp send message: %w", err)
	}
	return nil
}

// GetJIDPrefix returns the JID prefix for WhatsApp.
func (w *WhatsAppChannel) GetJIDPrefix() string {
	return whatsappPrefix
}

// IsConnected returns the current connection state.
func (w *WhatsAppChannel) IsConnected() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.connected
}

// OnMessage sets the callback for incoming messages.
func (w *WhatsAppChannel) OnMessage(callback func(jid string, content string)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onMessage = callback
}

// OnMetadata sets the callback for metadata events (QR codes etc.).
func (w *WhatsAppChannel) OnMetadata(callback func(jid string, metadata map[string]string)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onMetadata = callback
}

// handleEvent processes whatsmeow events. Only processes text messages; ignores protocol/media.
func (w *WhatsAppChannel) handleEvent(rawEvt interface{}) {
	switch evt := rawEvt.(type) {
	case *events.Message:
		w.handleMessage(evt)
	case *events.Disconnected:
		w.logger.Warn("whatsapp disconnected, starting reconnection loop")
		w.mu.Lock()
		w.connected = false
		w.mu.Unlock()
		go w.reconnectLoop()
	}
}

// handleMessage extracts text from a message event and calls onMessage.
func (w *WhatsAppChannel) handleMessage(evt *events.Message) {
	if evt.Info.IsFromMe {
		return
	}

	// Extract text-only messages; skip media-only, protocol, or empty messages.
	var text string
	if conv := evt.Message.GetConversation(); conv != "" {
		text = conv
	} else if ext := evt.Message.GetExtendedTextMessage(); ext != nil {
		text = ext.GetText()
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return
	}

	// Build JID: whatsapp:<phone_number>
	phone := evt.Info.Sender.User
	jid := fmt.Sprintf("%s:%s", whatsappPrefix, phone)

	w.mu.RLock()
	handler := w.onMessage
	w.mu.RUnlock()

	if handler != nil {
		handler(jid, text)
	}
}

// relayQRCodes reads from the QR channel and emits each code via onMetadata.
func (w *WhatsAppChannel) relayQRCodes(qrCh <-chan QRChannelItem) {
	for item := range qrCh {
		switch item.Type {
		case "code":
			w.mu.RLock()
			handler := w.onMetadata
			w.mu.RUnlock()
			if handler != nil {
				handler("whatsapp:qr", map[string]string{"qr": item.Code})
			}
			w.logger.Info("whatsapp: QR code received, awaiting scan")
		case "error":
			w.logger.Error("whatsapp: QR pairing error", "error", item.Error)
		case "success":
			w.logger.Info("whatsapp: QR pairing successful")
		}
	}
}

// reconnectLoop attempts to reconnect with exponential backoff until stopped.
func (w *WhatsAppChannel) reconnectLoop() {
	backoff := waBackoffBase
	for {
		select {
		case <-w.stopReconn:
			return
		default:
		}

		w.logger.Info("whatsapp: attempting reconnection", "backoff", backoff)
		w.mu.RLock()
		client := w.client
		w.mu.RUnlock()

		if client != nil {
			if err := client.Connect(); err != nil {
				w.logger.Warn("whatsapp: reconnection failed", "error", err, "retry_in", backoff)
			} else {
				w.logger.Info("whatsapp: reconnected successfully")
				w.mu.Lock()
				w.connected = true
				w.mu.Unlock()
				return
			}
		}

		select {
		case <-w.stopReconn:
			return
		case <-time.After(backoff):
		}

		backoff = time.Duration(float64(backoff) * waBackoffMultiplier)
		if backoff > waBackoffMax {
			backoff = waBackoffMax
		}
	}
}

// extractWhatsAppPhone extracts the phone number from a "whatsapp:<phone>" JID.
func extractWhatsAppPhone(jid string) string {
	const prefix = "whatsapp:"
	if strings.HasPrefix(jid, prefix) {
		return jid[len(prefix):]
	}
	return ""
}
