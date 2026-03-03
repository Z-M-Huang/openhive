package channel

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/bwmarrin/discordgo"
)

const (
	discordPrefix       = "discord"
	discordMaxChunkSize = 2000
	discordRateWindow   = 5 * time.Second
	discordRateLimit    = 5
)

// DiscordSession is an interface wrapping the discordgo.Session methods we need,
// allowing injection of a mock in tests.
type DiscordSession interface {
	Open() error
	Close() error
	ChannelMessageSend(channelID string, content string, options ...discordgo.RequestOption) (*discordgo.Message, error)
	AddHandler(handler interface{}) func()
	State() *discordgo.State
}

// discordgoSessionAdapter wraps a *discordgo.Session to satisfy DiscordSession.
type discordgoSessionAdapter struct {
	s *discordgo.Session
}

func (a *discordgoSessionAdapter) Open() error  { return a.s.Open() }
func (a *discordgoSessionAdapter) Close() error { return a.s.Close() }
func (a *discordgoSessionAdapter) ChannelMessageSend(channelID string, content string, options ...discordgo.RequestOption) (*discordgo.Message, error) {
	return a.s.ChannelMessageSend(channelID, content, options...)
}
func (a *discordgoSessionAdapter) AddHandler(handler interface{}) func() {
	return a.s.AddHandler(handler)
}
func (a *discordgoSessionAdapter) State() *discordgo.State {
	return a.s.State
}

// DiscordSessionFactory creates a DiscordSession from a token.
// Overridable in tests.
type DiscordSessionFactory func(token string) (DiscordSession, error)

// defaultDiscordFactory creates a real discordgo session.
func defaultDiscordFactory(token string) (DiscordSession, error) {
	s, err := discordgo.New("Bot " + token)
	if err != nil {
		return nil, fmt.Errorf("failed to create discord session: %w", err)
	}
	s.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsDirectMessages
	return &discordgoSessionAdapter{s: s}, nil
}

// DiscordChannel implements domain.ChannelAdapter for Discord.
type DiscordChannel struct {
	session    DiscordSession
	channelID  string
	token      string
	enabled    bool
	factory    DiscordSessionFactory
	eventBus   domain.EventBus
	logger     *slog.Logger
	onMessage  func(jid string, content string)
	onMetadata func(jid string, metadata map[string]string)
	mu         sync.RWMutex
	connected  bool

	// botUserID is set after Connect() resolves the bot's own user ID
	botUserID string

	// Rate limiting: track per-channel send times
	rateMu    sync.Mutex
	sendTimes []time.Time
}

// DiscordConfig holds the configuration for the Discord channel.
type DiscordConfig struct {
	Token     string
	ChannelID string
	Enabled   bool
}

// NewDiscordChannel creates a new Discord channel adapter.
// factory may be nil to use the default discordgo factory.
func NewDiscordChannel(cfg DiscordConfig, eventBus domain.EventBus, logger *slog.Logger, factory DiscordSessionFactory) *DiscordChannel {
	if factory == nil {
		factory = defaultDiscordFactory
	}
	return &DiscordChannel{
		token:     cfg.Token,
		channelID: cfg.ChannelID,
		enabled:   cfg.Enabled,
		factory:   factory,
		eventBus:  eventBus,
		logger:    logger,
	}
}

// HandleConfigChange reacts to a MasterConfig change event.
// It compares the new Discord channel config to the current state and
// connects, disconnects, or reconnects as needed.
//
// The caller is responsible for passing decrypted tokens — this method
// does not decrypt enc:-prefixed values.
func (d *DiscordChannel) HandleConfigChange(newToken, newChannelID string, newEnabled bool) {
	d.mu.Lock()
	oldEnabled := d.enabled
	oldToken := d.token
	oldChannelID := d.channelID
	wasConnected := d.connected
	d.mu.Unlock()

	switch {
	case oldEnabled && !newEnabled:
		// Was enabled, now disabled: disconnect.
		d.logger.Info("discord: config changed — disabling channel")
		if err := d.Disconnect(); err != nil {
			d.logger.Warn("discord: disconnect on disable failed", "error", err)
		}
		d.mu.Lock()
		d.enabled = false
		d.mu.Unlock()

	case !oldEnabled && newEnabled:
		// Was disabled, now enabled: update credentials and connect.
		d.logger.Info("discord: config changed — enabling channel")
		d.mu.Lock()
		d.token = newToken
		d.channelID = newChannelID
		d.enabled = true
		d.mu.Unlock()
		if err := d.Connect(); err != nil {
			d.logger.Warn("discord: connect on enable failed", "error", err)
		}

	case newEnabled && wasConnected && (newToken != oldToken || newChannelID != oldChannelID):
		// Credentials changed while connected: reconnect with new credentials.
		d.logger.Info("discord: config changed — reconnecting with new credentials")
		if err := d.Disconnect(); err != nil {
			d.logger.Warn("discord: disconnect before credential update failed", "error", err)
		}
		d.mu.Lock()
		d.token = newToken
		d.channelID = newChannelID
		d.enabled = true
		d.mu.Unlock()
		if err := d.Connect(); err != nil {
			d.logger.Warn("discord: reconnect after credential update failed", "error", err)
		}

	default:
		// No actionable change (e.g. still disabled, or enabled+connected with same credentials).
		d.mu.Lock()
		d.token = newToken
		d.channelID = newChannelID
		d.enabled = newEnabled
		d.mu.Unlock()
	}
}

// Connect opens the Discord session and registers the message handler.
func (d *DiscordChannel) Connect() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.connected {
		return nil
	}

	s, err := d.factory(d.token)
	if err != nil {
		return fmt.Errorf("discord connect: failed to create session: %w", err)
	}

	d.session = s

	// Register the message-create handler before opening the session.
	s.AddHandler(d.handleMessageCreate)

	if err := s.Open(); err != nil {
		return fmt.Errorf("discord connect: failed to open session: %w", err)
	}

	// Retrieve the bot's own user ID from the session state (via embedded Ready.User).
	if state := s.State(); state != nil && state.Ready.User != nil {
		d.botUserID = state.Ready.User.ID
	}

	d.connected = true
	d.logger.Info("discord channel connected", "channel_id", d.channelID)
	return nil
}

// Disconnect closes the Discord session.
func (d *DiscordChannel) Disconnect() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if !d.connected {
		return nil
	}
	if d.session != nil {
		if err := d.session.Close(); err != nil {
			d.logger.Warn("discord disconnect: session close error", "error", err)
		}
	}
	d.connected = false
	d.logger.Info("discord channel disconnected", "channel_id", d.channelID)
	return nil
}

// SendMessage sends a message to the Discord channel, splitting long content
// at paragraph or sentence boundaries so each chunk is <=2000 characters.
// Rate-limited to 5 messages per 5 seconds.
func (d *DiscordChannel) SendMessage(jid string, content string) error {
	d.mu.RLock()
	sess := d.session
	connected := d.connected
	d.mu.RUnlock()

	if !connected || sess == nil {
		return &domain.ValidationError{Field: "connection", Message: "discord channel is not connected"}
	}

	chunks := splitMessage(content, discordMaxChunkSize)
	for _, chunk := range chunks {
		if err := d.sendWithRateLimit(sess, chunk); err != nil {
			return err
		}
	}
	return nil
}

// GetJIDPrefix returns the JID prefix for Discord.
func (d *DiscordChannel) GetJIDPrefix() string {
	return discordPrefix
}

// IsConnected returns the current connection state.
func (d *DiscordChannel) IsConnected() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.connected
}

// OnMessage sets the callback for incoming messages.
func (d *DiscordChannel) OnMessage(callback func(jid string, content string)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.onMessage = callback
}

// OnMetadata sets the callback for metadata events (unused by Discord).
func (d *DiscordChannel) OnMetadata(callback func(jid string, metadata map[string]string)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.onMetadata = callback
}

// handleMessageCreate is the discordgo message-create event handler.
// Filters out bot/webhook/wrong-channel/self messages, then calls onMessage.
func (d *DiscordChannel) handleMessageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Filter: nil message or author
	if m == nil || m.Message == nil || m.Author == nil {
		return
	}

	// Filter: bot messages
	if m.Author.Bot {
		return
	}

	// Filter: webhook messages
	if m.WebhookID != "" {
		return
	}

	// Filter: wrong channel
	d.mu.RLock()
	channelID := d.channelID
	botUserID := d.botUserID
	d.mu.RUnlock()

	if channelID != "" && m.ChannelID != channelID {
		return
	}

	// Filter: self messages
	if botUserID != "" && m.Author.ID == botUserID {
		return
	}

	content := strings.TrimSpace(m.Content)
	if content == "" {
		return
	}

	jid := fmt.Sprintf("%s:%s:%s", discordPrefix, m.ChannelID, m.Author.ID)

	d.mu.RLock()
	handler := d.onMessage
	d.mu.RUnlock()

	if handler != nil {
		handler(jid, content)
	}
}

// sendWithRateLimit sends a single message chunk, enforcing the rate limit.
func (d *DiscordChannel) sendWithRateLimit(sess DiscordSession, chunk string) error {
	d.rateMu.Lock()
	now := time.Now()
	// Evict sends older than the rate window
	valid := d.sendTimes[:0]
	for _, t := range d.sendTimes {
		if now.Sub(t) < discordRateWindow {
			valid = append(valid, t)
		}
	}
	d.sendTimes = valid

	if len(d.sendTimes) >= discordRateLimit {
		d.rateMu.Unlock()
		return &domain.ValidationError{
			Field:   "rate_limit",
			Message: fmt.Sprintf("discord rate limit exceeded: max %d messages per %s", discordRateLimit, discordRateWindow),
		}
	}
	d.sendTimes = append(d.sendTimes, now)
	d.rateMu.Unlock()

	_, err := sess.ChannelMessageSend(d.channelID, chunk)
	if err != nil {
		return fmt.Errorf("discord send message: %w", err)
	}
	return nil
}

// HandleMessageCreateForTest exposes the internal message handler for integration tests.
// It should only be called in test code.
func (d *DiscordChannel) HandleMessageCreateForTest(s *discordgo.Session, m *discordgo.MessageCreate) {
	d.handleMessageCreate(s, m)
}

// splitMessage splits content into chunks of at most maxLen characters.
// It prefers to split at paragraph boundaries (\n\n), then sentence boundaries (. ! ?),
// then word boundaries, and as a last resort at the hard character limit.
func splitMessage(content string, maxLen int) []string {
	if len(content) <= maxLen {
		return []string{content}
	}

	var chunks []string
	remaining := content

	for len(remaining) > maxLen {
		chunk := remaining[:maxLen]

		// Try to split at a paragraph boundary (\n\n)
		if idx := strings.LastIndex(chunk, "\n\n"); idx > 0 {
			chunks = append(chunks, strings.TrimRight(remaining[:idx], " \t"))
			remaining = strings.TrimLeft(remaining[idx+2:], " \t")
			continue
		}

		// Try to split at a sentence boundary (. ! ?)
		splitIdx := -1
		for i := len(chunk) - 1; i >= 0; i-- {
			if chunk[i] == '.' || chunk[i] == '!' || chunk[i] == '?' {
				// Only split if followed by a space or newline (or end of chunk)
				if i+1 < len(chunk) && (chunk[i+1] == ' ' || chunk[i+1] == '\n') {
					splitIdx = i + 1
					break
				}
			}
		}
		if splitIdx > 0 {
			chunks = append(chunks, strings.TrimRight(remaining[:splitIdx], " \t"))
			remaining = strings.TrimLeft(remaining[splitIdx:], " \t")
			continue
		}

		// Try to split at a word boundary (space or newline)
		for i := len(chunk) - 1; i >= 0; i-- {
			if chunk[i] == ' ' || chunk[i] == '\n' {
				splitIdx = i
				break
			}
		}
		if splitIdx > 0 {
			chunks = append(chunks, strings.TrimRight(remaining[:splitIdx], " \t"))
			remaining = strings.TrimLeft(remaining[splitIdx:], " \t")
			continue
		}

		// Hard split at maxLen
		chunks = append(chunks, remaining[:maxLen])
		remaining = remaining[maxLen:]
	}

	if strings.TrimSpace(remaining) != "" {
		chunks = append(chunks, remaining)
	}
	return chunks
}
