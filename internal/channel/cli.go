package channel

import (
	"bufio"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

const (
	cliJID           = "cli:local"
	cliPrefix        = "cli"
	multilineStart   = "<<<"
	multilineEnd     = ">>>"
	pasteDetectDelay = 50 * time.Millisecond
)

// CLIChannel implements the ChannelAdapter interface for stdin/stdout REPL.
type CLIChannel struct {
	reader     *bufio.Scanner
	writer     io.Writer
	onMessage  func(jid string, content string)
	onMetadata func(jid string, metadata map[string]string)
	done       chan struct{}
	connected  bool
	mu         sync.RWMutex
	waitingMu  sync.Mutex
	waiting    bool
}

// NewCLIChannel creates a new CLI channel adapter.
func NewCLIChannel(reader io.Reader, writer io.Writer) *CLIChannel {
	return &CLIChannel{
		reader: bufio.NewScanner(reader),
		writer: writer,
		done:   make(chan struct{}),
	}
}

// Connect starts the CLI REPL loop.
func (c *CLIChannel) Connect() error {
	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()

	fmt.Fprintln(c.writer, "OpenHive CLI - Type a message or /quit to exit")
	fmt.Fprintln(c.writer, "Use <<< to start multi-line input, >>> to end")

	go c.readLoop()
	return nil
}

// Disconnect stops the CLI REPL loop.
func (c *CLIChannel) Disconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.connected {
		return nil
	}
	c.connected = false
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	return nil
}

// SendMessage prints a message to the output writer.
func (c *CLIChannel) SendMessage(jid string, content string) error {
	c.waitingMu.Lock()
	c.waiting = false
	c.waitingMu.Unlock()

	fmt.Fprintf(c.writer, "\n%s\n", content)
	c.printPrompt()
	return nil
}

// GetJIDPrefix returns the channel prefix.
func (c *CLIChannel) GetJIDPrefix() string {
	return cliPrefix
}

// IsConnected returns the connection state.
func (c *CLIChannel) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// OnMessage sets the callback for incoming messages.
func (c *CLIChannel) OnMessage(callback func(jid string, content string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onMessage = callback
}

// OnMetadata sets the callback for metadata events.
func (c *CLIChannel) OnMetadata(callback func(jid string, metadata map[string]string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onMetadata = callback
}

func (c *CLIChannel) readLoop() {
	defer func() {
		_ = c.Disconnect()
	}()

	c.printPrompt()

	for c.reader.Scan() {
		select {
		case <-c.done:
			return
		default:
		}

		line := c.reader.Text()

		// Check for multi-line start
		if strings.TrimSpace(line) == multilineStart {
			content := c.readMultiLine()
			if content != "" {
				c.dispatchMessage(content)
			}
			continue
		}

		// Handle slash commands
		trimmed := strings.TrimSpace(line)
		if trimmed == "/quit" || trimmed == "/exit" {
			fmt.Fprintln(c.writer, "Goodbye!")
			return
		}

		if trimmed == "" {
			c.printPrompt()
			continue
		}

		c.dispatchMessage(trimmed)
	}

	// EOF (Ctrl+D)
}

func (c *CLIChannel) readMultiLine() string {
	var lines []string
	for c.reader.Scan() {
		line := c.reader.Text()
		if strings.TrimSpace(line) == multilineEnd {
			break
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func (c *CLIChannel) dispatchMessage(content string) {
	c.waitingMu.Lock()
	c.waiting = true
	c.waitingMu.Unlock()

	fmt.Fprint(c.writer, "...")

	c.mu.RLock()
	handler := c.onMessage
	c.mu.RUnlock()

	if handler != nil {
		handler(cliJID, content)
	}
}

func (c *CLIChannel) printPrompt() {
	fmt.Fprint(c.writer, "> ")
}
