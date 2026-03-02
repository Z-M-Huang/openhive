package channel

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	apiPrefix  = "api"
	apiTimeout = 5 * time.Minute
	// Maximum request body size for chat requests (1MB).
	apiMaxBodySize = 1 << 20
)

// APIChannel implements the ChannelAdapter interface for REST-based
// synchronous request/response. Each HTTP request blocks until the agent
// responds or the request times out.
type APIChannel struct {
	mu         sync.RWMutex
	pending    map[string]chan string
	onMessage  func(jid string, content string)
	onMetadata func(jid string, metadata map[string]string)
	counter    atomic.Int64
	connected  bool
	logger     *slog.Logger
}

// NewAPIChannel creates a new REST-based channel adapter.
func NewAPIChannel(logger *slog.Logger) *APIChannel {
	return &APIChannel{
		pending: make(map[string]chan string),
		logger:  logger,
	}
}

// Connect enables the channel to accept requests.
func (a *APIChannel) Connect() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.connected = true
	return nil
}

// Disconnect disables the channel and closes all pending response channels.
func (a *APIChannel) Disconnect() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.connected = false
	for jid, ch := range a.pending {
		close(ch)
		delete(a.pending, jid)
	}
	return nil
}

// SendMessage delivers the agent's response to the pending HTTP request
// identified by JID. Returns nil if the JID is not found (request may have
// timed out or client disconnected).
//
// The RLock is held through the channel send to prevent Disconnect() from
// closing the channel between lookup and send (which would panic).
func (a *APIChannel) SendMessage(jid string, content string) error {
	a.mu.RLock()
	defer a.mu.RUnlock()

	ch, exists := a.pending[jid]
	if !exists {
		a.logger.Debug("send message: no pending request", "jid", jid)
		return nil
	}

	a.logger.Debug("send message: delivering response", "jid", jid, "content_len", len(content))
	select {
	case ch <- content:
	default:
	}
	return nil
}

// GetJIDPrefix returns the channel prefix for JID routing.
func (a *APIChannel) GetJIDPrefix() string {
	return apiPrefix
}

// IsConnected returns whether the channel is accepting requests.
func (a *APIChannel) IsConnected() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.connected
}

// OnMessage sets the callback invoked when a chat message arrives.
func (a *APIChannel) OnMessage(callback func(jid string, content string)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onMessage = callback
}

// OnMetadata sets the callback for metadata events.
func (a *APIChannel) OnMetadata(callback func(jid string, metadata map[string]string)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onMetadata = callback
}

type chatRequest struct {
	Content string `json:"content"`
}

type chatResponseData struct {
	Response string `json:"response"`
}

// HandleChat is an http.HandlerFunc that accepts POST requests with
// {"content":"..."}, blocks until the agent responds, and returns
// {"data":{"response":"..."}}.
func (a *APIChannel) HandleChat(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	connected := a.connected
	handler := a.onMessage
	a.mu.RUnlock()

	if !connected {
		apiError(w, http.StatusServiceUnavailable, "CHANNEL_UNAVAILABLE", "chat channel is not connected")
		return
	}

	// Limit request body size
	r.Body = http.MaxBytesReader(w, r.Body, apiMaxBodySize)

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apiError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body")
		return
	}
	if req.Content == "" {
		apiError(w, http.StatusBadRequest, "INVALID_REQUEST", "content must not be empty")
		return
	}

	// Generate unique JID
	n := a.counter.Add(1)
	jid := fmt.Sprintf("%s:%d", apiPrefix, n)
	a.logger.Debug("chat request received", "jid", jid, "content_len", len(req.Content))

	// Register pending response channel with a double-check on connected
	// to prevent adding entries after Disconnect() has drained the map.
	ch := make(chan string, 1)
	a.mu.Lock()
	if !a.connected {
		a.mu.Unlock()
		apiError(w, http.StatusServiceUnavailable, "CHANNEL_UNAVAILABLE", "chat channel is not connected")
		return
	}
	a.pending[jid] = ch
	a.mu.Unlock()

	defer func() {
		a.mu.Lock()
		delete(a.pending, jid)
		a.mu.Unlock()
	}()

	// Start timeout before dispatch so it covers the full request lifecycle,
	// including any time spent in the synchronous handler call.
	timer := time.NewTimer(apiTimeout)
	defer timer.Stop()

	// Dispatch to router (synchronous — creates task and sends via WS)
	if handler != nil {
		handler(jid, req.Content)
	}

	// Block until response, timeout, or client disconnect

	select {
	case resp, ok := <-ch:
		if !ok {
			a.logger.Debug("chat channel closed while waiting", "jid", jid)
			apiError(w, http.StatusServiceUnavailable, "CHANNEL_DISCONNECTED", "channel disconnected while waiting")
			return
		}
		a.logger.Debug("chat response received", "jid", jid, "response_len", len(resp))
		apiJSON(w, http.StatusOK, chatResponseData{Response: resp})
	case <-r.Context().Done():
		a.logger.Debug("chat client disconnected", "jid", jid)
		apiError(w, http.StatusGatewayTimeout, "CLIENT_DISCONNECTED", "client disconnected")
	case <-timer.C:
		a.logger.Debug("chat request timed out", "jid", jid)
		apiError(w, http.StatusGatewayTimeout, "TIMEOUT", "response timed out")
	}
}

// apiJSON writes a JSON success response matching the api package format.
func apiJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
}

// apiError writes a JSON error response matching the api package format.
func apiError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
		},
	})
}
