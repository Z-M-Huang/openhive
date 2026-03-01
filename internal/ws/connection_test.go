package ws

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestWSPair(t *testing.T) (*Connection, *websocket.Conn) {
	t.Helper()

	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	var receivedMsg []byte
	var closeCalled atomic.Bool

	var serverConn *websocket.Conn
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		var err error
		serverConn, err = up.Upgrade(w, r, nil)
		require.NoError(t, err)
	}))

	// Connect client
	wsURL := "ws" + server.URL[len("http"):]
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)

	// Wait for server connection
	require.Eventually(t, func() bool { return serverConn != nil }, 2*time.Second, 10*time.Millisecond)

	conn := NewConnection(serverConn, "tid-test-001", logger,
		func(teamID string, msg []byte) {
			receivedMsg = append(receivedMsg[:0], msg...)
		},
		func(teamID string) {
			closeCalled.Store(true)
		},
	)

	t.Cleanup(func() {
		conn.Close()
		client.Close()
		server.Close()
	})

	_ = receivedMsg

	return conn, client
}

func TestConnection_SendAndReceive(t *testing.T) {
	conn, client := setupTestWSPair(t)

	var received atomic.Value
	conn.onMessage = func(teamID string, msg []byte) {
		received.Store(string(msg))
	}
	conn.Start()

	// Client sends a message
	err := client.WriteMessage(websocket.TextMessage, []byte(`{"type":"ready"}`))
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		v := received.Load()
		return v != nil
	}, 2*time.Second, 10*time.Millisecond)

	assert.Contains(t, received.Load().(string), "ready")
}

func TestConnection_ServerSendsToClient(t *testing.T) {
	conn, client := setupTestWSPair(t)
	conn.Start()

	// Server sends to client
	err := conn.Send([]byte(`{"type":"task_dispatch"}`))
	require.NoError(t, err)

	_, msg, err := client.ReadMessage()
	require.NoError(t, err)
	assert.Contains(t, string(msg), "task_dispatch")
}

func TestConnection_TeamID(t *testing.T) {
	conn, _ := setupTestWSPair(t)
	assert.Equal(t, "tid-test-001", conn.TeamID())
}

func TestConnection_CloseNotifiesCallback(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	var closeCalled atomic.Bool

	var serverConn *websocket.Conn
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		var err error
		serverConn, err = up.Upgrade(w, r, nil)
		require.NoError(t, err)
	}))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):]
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client.Close()

	require.Eventually(t, func() bool { return serverConn != nil }, 2*time.Second, 10*time.Millisecond)

	conn := NewConnection(serverConn, "tid-test-close", logger,
		nil,
		func(teamID string) { closeCalled.Store(true) },
	)
	conn.Start()

	// Client closes its end
	client.Close()

	require.Eventually(t, func() bool {
		return closeCalled.Load()
	}, 2*time.Second, 10*time.Millisecond)
}

func TestConnection_DoubleClose(t *testing.T) {
	conn, _ := setupTestWSPair(t)
	// Should not panic
	conn.Close()
	conn.Close()
}

func TestConnection_WriteChannelFull(t *testing.T) {
	conn, _ := setupTestWSPair(t)
	// Fill the write channel without starting the write pump
	for range writeChSize {
		conn.writeCh <- []byte("fill")
	}

	// Next send should return an error
	err := conn.Send([]byte("overflow"))
	assert.Error(t, err)
}

func TestConnection_WriteError(t *testing.T) {
	e := &writeError{teamID: "tid-test-001"}
	assert.Contains(t, e.Error(), "tid-test-001")
}
