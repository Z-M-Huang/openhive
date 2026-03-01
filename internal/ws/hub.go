package ws

import (
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  readWriteBuffer,
	WriteBufferSize: readWriteBuffer,
	CheckOrigin:     func(r *http.Request) bool { return true }, // Token auth is the security mechanism
}

// Hub manages WebSocket connections from team containers.
type Hub struct {
	connections map[string]*Connection
	tokens      *TokenManager
	mu          sync.RWMutex
	logger      *slog.Logger
	onMessage   func(teamID string, msg []byte)
}

// NewHub creates a new WebSocket hub.
func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		connections: make(map[string]*Connection),
		tokens:      NewTokenManager(),
		logger:      logger,
	}
}

// GenerateToken creates a one-time token for team container authentication.
func (h *Hub) GenerateToken(teamID string) (string, error) {
	return h.tokens.GenerateToken(teamID)
}

// HandleUpgrade handles WebSocket upgrade requests. It expects query params
// "team" and "token" for authentication.
func (h *Hub) HandleUpgrade(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	teamID, ok := h.tokens.ValidateAndConsume(token)
	if !ok {
		http.Error(w, "invalid or consumed token", http.StatusUnauthorized)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("websocket upgrade failed", "team_id", teamID, "error", err)
		return
	}

	conn := NewConnection(ws, teamID, h.logger, h.handleMessage, h.handleClose)
	_ = h.RegisterConnection(teamID, conn)
	conn.Start()

	h.logger.Info("container connected", "team_id", teamID)
}

func (h *Hub) handleMessage(teamID string, msg []byte) {
	h.mu.RLock()
	handler := h.onMessage
	h.mu.RUnlock()

	if handler != nil {
		handler(teamID, msg)
	}
}

func (h *Hub) handleClose(teamID string) {
	h.UnregisterConnection(teamID)
	h.logger.Info("container disconnected", "team_id", teamID)
}

// RegisterConnection registers a connection for a team ID.
func (h *Hub) RegisterConnection(teamID string, conn *Connection) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Close existing connection if any
	if existing, ok := h.connections[teamID]; ok {
		existing.Close()
	}

	h.connections[teamID] = conn
	return nil
}

// UnregisterConnection removes a team's connection from the registry.
func (h *Hub) UnregisterConnection(teamID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.connections, teamID)
}

// SendToTeam sends a message to a specific team's connection.
func (h *Hub) SendToTeam(teamID string, msg []byte) error {
	h.mu.RLock()
	conn, ok := h.connections[teamID]
	h.mu.RUnlock()

	if !ok {
		return &connectionNotFoundError{teamID: teamID}
	}

	return conn.Send(msg)
}

// BroadcastAll sends a message to all connected teams.
func (h *Hub) BroadcastAll(msg []byte) error {
	h.mu.RLock()
	conns := make([]*Connection, 0, len(h.connections))
	for _, conn := range h.connections {
		conns = append(conns, conn)
	}
	h.mu.RUnlock()

	for _, conn := range conns {
		if err := conn.Send(msg); err != nil {
			h.logger.Warn("broadcast send failed", "team_id", conn.TeamID(), "error", err)
		}
	}
	return nil
}

// GetConnectedTeams returns the IDs of all connected teams.
func (h *Hub) GetConnectedTeams() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	teams := make([]string, 0, len(h.connections))
	for id := range h.connections {
		teams = append(teams, id)
	}
	return teams
}

// SetOnMessage sets the handler for incoming messages from containers.
func (h *Hub) SetOnMessage(handler func(teamID string, msg []byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onMessage = handler
}

type connectionNotFoundError struct {
	teamID string
}

func (e *connectionNotFoundError) Error() string {
	return "no connection found for team " + e.teamID
}
