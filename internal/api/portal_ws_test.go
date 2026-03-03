package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/event"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// dialTestServer creates a test WS server with the portal handler and dials it.
func dialTestServer(t *testing.T, handler http.Handler, path string) (*websocket.Conn, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	return conn, srv
}

func newPortalWSTestBus(t *testing.T) *event.InMemoryBus {
	t.Helper()
	bus := event.NewEventBus()
	t.Cleanup(bus.Close)
	return bus
}

func TestPortalWSConnect_UpgradesConnection(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 10)

	conn, _ := dialTestServer(t, http.HandlerFunc(h.HandleUpgrade), "/")
	assert.NotNil(t, conn)
}

func TestPortalWSFilter_DeliversMatchingEvents(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 10)

	conn, _ := dialTestServer(t, http.HandlerFunc(h.HandleUpgrade), "/?include_debug=true")

	// Allow subscription goroutine to register
	time.Sleep(20 * time.Millisecond)

	// Publish a log entry event
	logEntry := &domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "test",
		Action:    "test_action",
		Message:   "hello portal",
		CreatedAt: time.Now(),
	}
	bus.Publish(domain.Event{
		Type:    domain.EventTypeLogEntry,
		Payload: logEntry,
	})

	// Read the event from WS
	conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, msg, err := conn.ReadMessage()
	require.NoError(t, err)

	var receivedEvent domain.Event
	require.NoError(t, json.Unmarshal(msg, &receivedEvent))
	assert.Equal(t, domain.EventTypeLogEntry, receivedEvent.Type)
}

func TestPortalWSExcludeDebug_ByDefault(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 10)

	// No include_debug param — debug events should be excluded
	conn, _ := dialTestServer(t, http.HandlerFunc(h.HandleUpgrade), "/")
	time.Sleep(20 * time.Millisecond)

	// Publish debug log entry
	bus.Publish(domain.Event{
		Type: domain.EventTypeLogEntry,
		Payload: &domain.LogEntry{
			Level:     domain.LogLevelDebug,
			Component: "test",
			Action:    "action",
			Message:   "debug message",
			CreatedAt: time.Now(),
		},
	})

	// Should NOT receive it
	conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, _, err := conn.ReadMessage()
	assert.Error(t, err, "expected no message for debug event when exclude_debug is true")
}

func TestPortalWSIncludeDebug_WhenRequested(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 10)

	conn, _ := dialTestServer(t, http.HandlerFunc(h.HandleUpgrade), "/?include_debug=true")
	time.Sleep(20 * time.Millisecond)

	bus.Publish(domain.Event{
		Type: domain.EventTypeLogEntry,
		Payload: &domain.LogEntry{
			Level:     domain.LogLevelDebug,
			Component: "test",
			Action:    "action",
			Message:   "debug message",
			CreatedAt: time.Now(),
		},
	})

	conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, msg, err := conn.ReadMessage()
	require.NoError(t, err)
	// EventType is serialized as integer; EventTypeLogEntry == 12
	assert.Contains(t, string(msg), "debug message")
}

func TestPortalWSDisconnect_CleansUpSubscription(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 10)

	conn, _ := dialTestServer(t, http.HandlerFunc(h.HandleUpgrade), "/")
	time.Sleep(20 * time.Millisecond)

	assert.Equal(t, 1, h.ActiveConnections())

	// Close the connection
	conn.Close()
	time.Sleep(50 * time.Millisecond)

	assert.Equal(t, 0, h.ActiveConnections())
}

func TestPortalWSRateLimit_RejectsExcessConnections(t *testing.T) {
	bus := newPortalWSTestBus(t)
	h := NewPortalWSHandler(bus, newTestLogger(), 1) // max 1 connection

	srv := httptest.NewServer(http.HandlerFunc(h.HandleUpgrade))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"

	// First connection should succeed
	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	t.Cleanup(func() { conn1.Close() })
	time.Sleep(20 * time.Millisecond)

	// Second connection should be rejected (HTTP 429)
	httpURL := strings.Replace(wsURL, "ws://", "http://", 1)
	resp, err := http.Get(httpURL)
	require.NoError(t, err)
	defer resp.Body.Close()
	// WS upgrade is done via HTTP; rate limit returns 429 before upgrade
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
}

func TestPortalWSCheckOrigin_LocalhostOnly(t *testing.T) {
	tests := []struct {
		origin  string
		allowed bool
	}{
		{"http://localhost:3000", true},
		{"http://127.0.0.1:8080", true},
		{"http://localhost", true},
		{"http://evil.example.com", false},
		{"http://notlocalhost.com", false},
	}

	for _, tc := range tests {
		req, _ := http.NewRequest("GET", "/", nil)
		req.Header.Set("Origin", tc.origin)
		got := checkPortalOrigin(req)
		if tc.allowed {
			assert.True(t, got, "expected %s to be allowed", tc.origin)
		} else {
			assert.False(t, got, "expected %s to be rejected", tc.origin)
		}
	}
}

// newTestLogger creates a discarding logger for use in tests.
func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
