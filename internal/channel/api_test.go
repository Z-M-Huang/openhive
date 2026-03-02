package channel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestAPIChannel_GetJIDPrefix(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	assert.Equal(t, "api", ch.GetJIDPrefix())
}

func TestAPIChannel_ConnectDisconnect(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	assert.False(t, ch.IsConnected())

	require.NoError(t, ch.Connect())
	assert.True(t, ch.IsConnected())

	require.NoError(t, ch.Disconnect())
	assert.False(t, ch.IsConnected())
}

func TestAPIChannel_HandleChat_Success(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	ch.OnMessage(func(jid string, content string) {
		assert.Equal(t, "hello", content)
		assert.True(t, strings.HasPrefix(jid, "api:"))
		go func() {
			_ = ch.SendMessage(jid, "Hello back!")
		}()
	})
	require.NoError(t, ch.Connect())

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	data, ok := resp["data"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "Hello back!", data["response"])
}

func TestAPIChannel_HandleChat_NotConnected(t *testing.T) {
	ch := NewAPIChannel(testLogger())

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "CHANNEL_UNAVAILABLE")
}

func TestAPIChannel_HandleChat_InvalidBody(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader("not json"))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_REQUEST")
}

func TestAPIChannel_HandleChat_EmptyContent(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())

	body := `{"content": ""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_REQUEST")
}

func TestAPIChannel_HandleChat_MissingContentField(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())

	body := `{"message": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_REQUEST")
}

func TestAPIChannel_HandleChat_ClientDisconnect(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	ch.OnMessage(func(jid string, content string) {
		// Don't respond — simulate slow agent
	})
	require.NoError(t, ch.Connect())

	ctx, cancel := context.WithCancel(context.Background())
	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusGatewayTimeout, w.Code)
	assert.Contains(t, w.Body.String(), "CLIENT_DISCONNECTED")
}

func TestAPIChannel_HandleChat_DisconnectWhileWaiting(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	ch.OnMessage(func(jid string, content string) {
		go func() {
			time.Sleep(50 * time.Millisecond)
			_ = ch.Disconnect()
		}()
	})
	require.NoError(t, ch.Connect())

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()

	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "CHANNEL_DISCONNECTED")
}

func TestAPIChannel_SendMessage_NoMatchingJID(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	err := ch.SendMessage("api:999", "orphaned response")
	require.NoError(t, err)
}

func TestAPIChannel_OnMetadata(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	var called bool
	ch.OnMetadata(func(jid string, metadata map[string]string) {
		called = true
	})
	assert.False(t, called)
}

func TestAPIChannel_JIDUniqueness(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	var jids []string
	ch.OnMessage(func(jid string, content string) {
		jids = append(jids, jid)
		go func() { _ = ch.SendMessage(jid, "ok") }()
	})
	require.NoError(t, ch.Connect())

	for i := 0; i < 3; i++ {
		body := `{"content": "msg"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
		w := httptest.NewRecorder()
		ch.HandleChat(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
	}

	seen := make(map[string]bool)
	for _, jid := range jids {
		assert.False(t, seen[jid], "duplicate JID: %s", jid)
		seen[jid] = true
	}
	assert.Len(t, seen, 3)
}

func TestAPIChannel_PendingCleanup(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	ch.OnMessage(func(jid string, content string) {
		go func() { _ = ch.SendMessage(jid, "response") }()
	})
	require.NoError(t, ch.Connect())

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()
	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	// After request completes, pending map should be empty
	ch.mu.RLock()
	assert.Empty(t, ch.pending)
	ch.mu.RUnlock()
}

func TestAPIChannel_DisconnectClosesPending(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())

	// Manually add a pending channel
	testCh := make(chan string, 1)
	ch.mu.Lock()
	ch.pending["api:test"] = testCh
	ch.mu.Unlock()

	require.NoError(t, ch.Disconnect())

	// Channel should be closed
	_, ok := <-testCh
	assert.False(t, ok, "pending channel should be closed after disconnect")

	// Pending map should be empty
	ch.mu.RLock()
	assert.Empty(t, ch.pending)
	ch.mu.RUnlock()
}

func TestAPIChannel_DoubleDisconnect(t *testing.T) {
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())
	require.NoError(t, ch.Disconnect())
	require.NoError(t, ch.Disconnect())
}

func TestAPIChannel_HandleChat_DisconnectBetweenCheckAndRegister(t *testing.T) {
	// Verify the double-check on connected status works:
	// If the channel is disconnected after the initial check but before
	// registering the pending channel, we should get 503.
	ch := NewAPIChannel(testLogger())
	require.NoError(t, ch.Connect())
	require.NoError(t, ch.Disconnect())

	body := `{"content": "hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat", strings.NewReader(body))
	w := httptest.NewRecorder()
	ch.HandleChat(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}
