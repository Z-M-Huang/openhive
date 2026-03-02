package ws

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	return NewHub(logger)
}

func TestHub_GenerateToken(t *testing.T) {
	hub := newTestHub(t)
	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)
	assert.Len(t, token, 64) // 32 bytes hex encoded
}

func TestHub_HandleUpgrade_ValidToken(t *testing.T) {
	hub := newTestHub(t)
	var received atomic.Value

	hub.SetOnMessage(func(teamID string, msg []byte) {
		received.Store(string(msg))
	})

	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client.Close()

	// Connection should be registered
	require.Eventually(t, func() bool {
		teams := hub.GetConnectedTeams()
		return len(teams) == 1 && teams[0] == "tid-team-001"
	}, 2*time.Second, 10*time.Millisecond)

	// Client sends message
	err = client.WriteMessage(websocket.TextMessage, []byte(`{"type":"ready"}`))
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		v := received.Load()
		return v != nil
	}, 2*time.Second, 10*time.Millisecond)
}

func TestHub_HandleUpgrade_ReusedToken(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	// First connection succeeds
	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client1.Close()

	// Second connection with same token fails
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	assert.Error(t, err)
	if resp != nil {
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	}
}

func TestHub_HandleUpgrade_InvalidToken(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):] + "?token=invalid-token"
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	assert.Error(t, err)
	if resp != nil {
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	}
}

func TestHub_HandleUpgrade_MissingToken(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):]
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	assert.Error(t, err)
	if resp != nil {
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	}
}

func TestHub_SendToTeam(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client.Close()

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 1
	}, 2*time.Second, 10*time.Millisecond)

	// Send to team
	err = hub.SendToTeam("tid-team-001", []byte(`{"type":"task_dispatch"}`))
	require.NoError(t, err)

	_, msg, err := client.ReadMessage()
	require.NoError(t, err)
	assert.Contains(t, string(msg), "task_dispatch")
}

func TestHub_SendToTeam_NotFound(t *testing.T) {
	hub := newTestHub(t)
	err := hub.SendToTeam("nonexistent", []byte("msg"))
	assert.Error(t, err)
}

func TestHub_BroadcastAll(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	// Connect two teams
	clients := make([]*websocket.Conn, 2)
	for i, teamID := range []string{"tid-team-001", "tid-team-002"} {
		token, err := hub.GenerateToken(teamID)
		require.NoError(t, err)

		wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
		c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		require.NoError(t, err)
		defer c.Close()
		clients[i] = c
	}

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 2
	}, 2*time.Second, 10*time.Millisecond)

	// Broadcast
	err := hub.BroadcastAll([]byte(`{"type":"shutdown"}`))
	require.NoError(t, err)

	for _, c := range clients {
		_, msg, readErr := c.ReadMessage()
		require.NoError(t, readErr)
		assert.Contains(t, string(msg), "shutdown")
	}
}

func TestHub_GetConnectedTeams(t *testing.T) {
	hub := newTestHub(t)
	assert.Empty(t, hub.GetConnectedTeams())

	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client.Close()

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 1
	}, 2*time.Second, 10*time.Millisecond)

	teams := hub.GetConnectedTeams()
	assert.Contains(t, teams, "tid-team-001")
}

func TestHub_ClientDisconnect_RemovedFromRegistry(t *testing.T) {
	hub := newTestHub(t)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 1
	}, 2*time.Second, 10*time.Millisecond)

	// Disconnect client
	client.Close()

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 0
	}, 2*time.Second, 10*time.Millisecond)
}

func TestHub_RegisterConnection_ReplacesExisting(t *testing.T) {
	hub := newTestHub(t)
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	// Register first connection
	server1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		wsConn, upErr := up.Upgrade(w, r, nil)
		require.NoError(t, upErr)
		conn := NewConnection(wsConn, "tid-team-001", logger, nil, nil)
		_ = hub.RegisterConnection("tid-team-001", conn)
	}))
	defer server1.Close()

	wsURL := "ws" + server1.URL[len("http"):]
	c1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer c1.Close()

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 1
	}, 2*time.Second, 10*time.Millisecond)

	// Register a new connection for the same team (should replace)
	server2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		wsConn, upErr := up.Upgrade(w, r, nil)
		require.NoError(t, upErr)
		conn := NewConnection(wsConn, "tid-team-001", logger, nil, nil)
		_ = hub.RegisterConnection("tid-team-001", conn)
	}))
	defer server2.Close()

	wsURL2 := "ws" + server2.URL[len("http"):]
	c2, _, err := websocket.DefaultDialer.Dial(wsURL2, nil)
	require.NoError(t, err)
	defer c2.Close()

	time.Sleep(100 * time.Millisecond)
	teams := hub.GetConnectedTeams()
	assert.Len(t, teams, 1)
}

func TestHub_SetOnMessage(t *testing.T) {
	hub := newTestHub(t)

	var called atomic.Bool
	hub.SetOnMessage(func(teamID string, msg []byte) {
		called.Store(true)
	})

	server := httptest.NewServer(http.HandlerFunc(hub.HandleUpgrade))
	defer server.Close()

	token, err := hub.GenerateToken("tid-team-001")
	require.NoError(t, err)

	wsURL := "ws" + server.URL[len("http"):] + "?token=" + token
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer client.Close()

	require.Eventually(t, func() bool {
		return len(hub.GetConnectedTeams()) == 1
	}, 2*time.Second, 10*time.Millisecond)

	err = client.WriteMessage(websocket.TextMessage, []byte(`{"type":"heartbeat"}`))
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		return called.Load()
	}, 2*time.Second, 10*time.Millisecond)
}

func TestHub_SendToTeam_NotFound_DomainError(t *testing.T) {
	hub := newTestHub(t)
	err := hub.SendToTeam("nonexistent", []byte("msg"))
	assert.Error(t, err)
	var nfe *domain.NotFoundError
	assert.True(t, errors.As(err, &nfe))
	assert.Equal(t, "ws_connection", nfe.Resource)
	assert.Equal(t, "nonexistent", nfe.ID)
}
