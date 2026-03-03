package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/gorilla/websocket"
)

const (
	defaultPortalWSMaxConnections = 10
)

// portalWSUpgrader upgrades portal WebSocket connections.
// CheckOrigin validates localhost-only origins for security.
var portalWSUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     checkPortalOrigin,
}

// checkPortalOrigin allows only localhost origins for the portal WebSocket.
func checkPortalOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Direct connection (e.g., CLI tools) — allow
		return true
	}
	host := strings.ToLower(origin)
	// Strip protocol
	if idx := strings.Index(host, "://"); idx >= 0 {
		host = host[idx+3:]
	}
	// Strip path
	if idx := strings.Index(host, "/"); idx >= 0 {
		host = host[:idx]
	}
	// Strip port
	if idx := strings.LastIndex(host, ":"); idx >= 0 {
		host = host[:idx]
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// PortalWSFilter defines the filtering criteria for a portal WebSocket connection.
type PortalWSFilter struct {
	TeamSlug     string
	MinLevel     domain.LogLevel
	ExcludeDebug bool
	EventTypes   []domain.EventType
}

// parsePortalWSFilter builds a filter from query parameters.
func parsePortalWSFilter(r *http.Request) PortalWSFilter {
	q := r.URL.Query()
	f := PortalWSFilter{
		TeamSlug:     q.Get("team"),
		ExcludeDebug: q.Get("include_debug") != "true",
	}

	levelStr := q.Get("level")
	if levelStr != "" {
		if lvl, err := domain.ParseLogLevel(levelStr); err == nil {
			f.MinLevel = lvl
		}
	} else {
		f.MinLevel = domain.LogLevelDebug
		if f.ExcludeDebug {
			f.MinLevel = domain.LogLevelInfo
		}
	}

	return f
}

// portalClient represents a connected portal WebSocket client.
type portalClient struct {
	conn   *websocket.Conn
	send   chan []byte
	subID  string
	mu     sync.Mutex
	closed bool
}

func (c *portalClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.send)
		_ = c.conn.Close()
	}
}

func (c *portalClient) writeLoop() {
	for msg := range c.send {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		err := c.conn.WriteMessage(websocket.TextMessage, msg)
		c.mu.Unlock()
		if err != nil {
			return
		}
	}
}

// PortalWSHandler provides the portal WebSocket endpoint for real-time event streaming.
// It is separate from the container WS hub, with its own upgrader and auth (no token needed
// since portal access is localhost-only by CheckOrigin).
type PortalWSHandler struct {
	eventBus       domain.EventBus
	logger         *slog.Logger
	clients        sync.Map // string (sub ID) -> *portalClient
	activeCount    atomic.Int32
	maxConnections int
}

// NewPortalWSHandler creates a new PortalWSHandler.
// maxConnections defaults to defaultPortalWSMaxConnections if <= 0.
func NewPortalWSHandler(eventBus domain.EventBus, logger *slog.Logger, maxConnections int) *PortalWSHandler {
	if maxConnections <= 0 {
		maxConnections = defaultPortalWSMaxConnections
	}
	return &PortalWSHandler{
		eventBus:       eventBus,
		logger:         logger,
		maxConnections: maxConnections,
	}
}

// HandleUpgrade upgrades an HTTP connection to a portal WebSocket connection.
// Query parameters:
//   - team=<slug>: filter events to a specific team
//   - level=<debug|info|warn|error>: minimum log level (default: info)
//   - include_debug=true: include debug-level events
func (h *PortalWSHandler) HandleUpgrade(w http.ResponseWriter, r *http.Request) {
	// Rate limit: reject if at max connections
	current := h.activeCount.Load()
	if int(current) >= h.maxConnections {
		Error(w, http.StatusTooManyRequests, "RATE_LIMITED",
			"maximum portal WebSocket connections reached")
		return
	}

	// Validate origin
	if !checkPortalOrigin(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}

	conn, err := portalWSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("portal ws upgrade failed", "error", err)
		return
	}

	h.activeCount.Add(1)
	filter := parsePortalWSFilter(r)

	client := &portalClient{
		conn: conn,
		send: make(chan []byte, 64),
	}

	// Build filter function for the event bus
	eventFilter := h.buildFilter(filter)

	// Subscribe to event bus
	subID := h.eventBus.FilteredSubscribe(domain.EventTypeLogEntry, eventFilter, func(event domain.Event) {
		if msg, marshalErr := json.Marshal(event); marshalErr == nil {
			select {
			case client.send <- msg:
			default:
				h.logger.Warn("portal ws client send buffer full, dropping event")
			}
		}
	})

	// Also subscribe to key event types (task updates, container state changes, etc.)
	taskSubID := h.eventBus.FilteredSubscribe(domain.EventTypeTaskUpdated, eventFilter, func(event domain.Event) {
		if msg, marshalErr := json.Marshal(event); marshalErr == nil {
			select {
			case client.send <- msg:
			default:
			}
		}
	})
	heartbeatSubID := h.eventBus.FilteredSubscribe(domain.EventTypeHeartbeatReceived, eventFilter, func(event domain.Event) {
		if msg, marshalErr := json.Marshal(event); marshalErr == nil {
			select {
			case client.send <- msg:
			default:
			}
		}
	})
	containerSubID := h.eventBus.FilteredSubscribe(domain.EventTypeContainerStateChanged, eventFilter, func(event domain.Event) {
		if msg, marshalErr := json.Marshal(event); marshalErr == nil {
			select {
			case client.send <- msg:
			default:
			}
		}
	})

	client.subID = subID
	h.clients.Store(subID, client)

	h.logger.Info("portal ws client connected",
		"remote_addr", r.RemoteAddr,
		"team_filter", filter.TeamSlug,
	)

	go client.writeLoop()

	// Read loop: drain messages from client (pings/pongs, close frames)
	go func() {
		defer func() {
			h.eventBus.Unsubscribe(subID)
			h.eventBus.Unsubscribe(taskSubID)
			h.eventBus.Unsubscribe(heartbeatSubID)
			h.eventBus.Unsubscribe(containerSubID)
			h.clients.Delete(subID)
			client.close()
			h.activeCount.Add(-1)
			h.logger.Info("portal ws client disconnected", "remote_addr", r.RemoteAddr)
		}()

		for {
			_, _, readErr := conn.ReadMessage()
			if readErr != nil {
				break
			}
		}
	}()
}

// buildFilter creates an EventBus filter function from a PortalWSFilter.
func (h *PortalWSHandler) buildFilter(f PortalWSFilter) func(domain.Event) bool {
	return func(event domain.Event) bool {
		// Log level filter: only applies to log entries
		if event.Type == domain.EventTypeLogEntry {
			if entry, ok := event.Payload.(*domain.LogEntry); ok {
				if entry.Level < f.MinLevel {
					return false
				}
				if f.ExcludeDebug && entry.Level == domain.LogLevelDebug {
					return false
				}
				if f.TeamSlug != "" && entry.TeamName != f.TeamSlug {
					return false
				}
			}
		}
		return true
	}
}

// ActiveConnections returns the number of active portal WS connections.
func (h *PortalWSHandler) ActiveConnections() int {
	return int(h.activeCount.Load())
}
