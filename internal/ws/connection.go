package ws

import (
	"log/slog"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

const (
	writeChSize    = 256
	maxMessageSize = 1 * 1024 * 1024 // 1MB
	writeDeadline  = 10 * time.Second
	pingInterval   = 30 * time.Second
	pongDeadline   = 10 * time.Second
	readWriteBuffer = 4096

	// Rate limiting: 100 messages/second with burst of 100
	messageRateLimit = 100
	messageRateBurst = 100
)

// Connection represents a single WebSocket connection to a container.
type Connection struct {
	ws          *websocket.Conn
	teamID      string
	writeCh     chan []byte
	done        chan struct{}
	rateLimiter *rate.Limiter
	logger      *slog.Logger
	onMessage   func(teamID string, msg []byte)
	onClose     func(teamID string)
}

// NewConnection creates a new WebSocket connection wrapper.
func NewConnection(
	ws *websocket.Conn,
	teamID string,
	logger *slog.Logger,
	onMessage func(teamID string, msg []byte),
	onClose func(teamID string),
) *Connection {
	return &Connection{
		ws:          ws,
		teamID:      teamID,
		writeCh:     make(chan []byte, writeChSize),
		done:        make(chan struct{}),
		rateLimiter: rate.NewLimiter(messageRateLimit, messageRateBurst),
		logger:      logger,
		onMessage:   onMessage,
		onClose:     onClose,
	}
}

// Start begins the read and write pump goroutines.
func (c *Connection) Start() {
	go c.writePump()
	go c.readPump()
}

// Send queues a message for writing. Non-blocking; if the channel is full,
// the connection is considered stalled and will be closed.
func (c *Connection) Send(msg []byte) error {
	select {
	case c.writeCh <- msg:
		return nil
	default:
		c.logger.Warn("write channel full, closing connection", "team_id", c.teamID)
		c.close()
		return &writeError{teamID: c.teamID}
	}
}

// Close closes the WebSocket connection.
func (c *Connection) Close() error {
	c.close()
	return nil
}

// TeamID returns the team ID for this connection.
func (c *Connection) TeamID() string {
	return c.teamID
}

func (c *Connection) close() {
	select {
	case <-c.done:
		// Already closed
	default:
		close(c.done)
		c.ws.Close()
	}
}

func (c *Connection) readPump() {
	defer func() {
		c.close()
		if c.onClose != nil {
			c.onClose(c.teamID)
		}
	}()

	c.ws.SetReadLimit(maxMessageSize)

	pongWait := pingInterval + pongDeadline
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, msg, err := c.ws.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				c.logger.Error("read error", "team_id", c.teamID, "error", err)
			}
			return
		}

		// Rate limit check
		if !c.rateLimiter.Allow() {
			c.logger.Warn("rate limit exceeded, closing connection",
				"team_id", c.teamID,
			)
			closeMsg := websocket.FormatCloseMessage(
				websocket.ClosePolicyViolation,
				"message rate limit exceeded",
			)
			_ = c.ws.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(writeDeadline))
			return
		}

		if c.onMessage != nil {
			c.onMessage(c.teamID, msg)
		}
	}
}

func (c *Connection) writePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		c.close()
	}()

	for {
		select {
		case msg, ok := <-c.writeCh:
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.logger.Error("write error", "team_id", c.teamID, "error", err)
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.logger.Error("ping error", "team_id", c.teamID, "error", err)
				return
			}
		case <-c.done:
			return
		}
	}
}

type writeError struct {
	teamID string
}

func (e *writeError) Error() string {
	return "write channel full for team " + e.teamID
}
