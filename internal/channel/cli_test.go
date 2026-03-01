package channel

import (
	"bytes"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupCLI(t *testing.T, input string) (*CLIChannel, *bytes.Buffer) {
	t.Helper()
	reader := strings.NewReader(input)
	var output bytes.Buffer
	cli := NewCLIChannel(reader, &output)
	return cli, &output
}

func TestCLIChannel_InputTriggersCallback(t *testing.T) {
	cli, _ := setupCLI(t, "hello world\n/quit\n")

	var receivedJID string
	var receivedContent string
	var called atomic.Bool

	cli.OnMessage(func(jid string, content string) {
		receivedJID = jid
		receivedContent = content
		called.Store(true)
	})

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return called.Load()
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, "cli:local", receivedJID)
	assert.Equal(t, "hello world", receivedContent)
}

func TestCLIChannel_SendMessagePrintsToStdout(t *testing.T) {
	cli, output := setupCLI(t, "")

	err := cli.SendMessage("cli:local", "Hello from assistant!")
	require.NoError(t, err)
	assert.Contains(t, output.String(), "Hello from assistant!")
}

func TestCLIChannel_GetJIDPrefix(t *testing.T) {
	cli, _ := setupCLI(t, "")
	assert.Equal(t, "cli", cli.GetJIDPrefix())
}

func TestCLIChannel_IsConnected(t *testing.T) {
	cli, _ := setupCLI(t, "/quit\n")

	assert.False(t, cli.IsConnected())

	require.NoError(t, cli.Connect())

	// Wait for read loop to process /quit
	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)
}

func TestCLIChannel_QuitCommand(t *testing.T) {
	cli, output := setupCLI(t, "/quit\n")

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	assert.Contains(t, output.String(), "Goodbye!")
}

func TestCLIChannel_ExitCommand(t *testing.T) {
	cli, output := setupCLI(t, "/exit\n")

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	assert.Contains(t, output.String(), "Goodbye!")
}

func TestCLIChannel_RegularMessage(t *testing.T) {
	cli, _ := setupCLI(t, "test message\n/quit\n")

	var received atomic.Value
	cli.OnMessage(func(jid string, content string) {
		received.Store(content)
	})

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return received.Load() != nil
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, "test message", received.Load().(string))
}

func TestCLIChannel_MultiLineInput(t *testing.T) {
	input := "<<<\nline 1\nline 2\nline 3\n>>>\n/quit\n"
	cli, _ := setupCLI(t, input)

	var received atomic.Value
	cli.OnMessage(func(jid string, content string) {
		received.Store(content)
	})

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return received.Load() != nil
	}, 2*time.Second, 10*time.Millisecond)

	result := received.Load().(string)
	assert.Contains(t, result, "line 1")
	assert.Contains(t, result, "line 2")
	assert.Contains(t, result, "line 3")
	assert.Contains(t, result, "\n")
}

func TestCLIChannel_EOF(t *testing.T) {
	// Empty input simulates EOF
	pr, pw := io.Pipe()
	var output bytes.Buffer
	cli := NewCLIChannel(pr, &output)

	require.NoError(t, cli.Connect())

	// Close the pipe writer to trigger EOF
	pw.Close()

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)
}

func TestCLIChannel_TypingIndicator(t *testing.T) {
	cli, output := setupCLI(t, "hello\n/quit\n")

	cli.OnMessage(func(jid string, content string) {
		// Simulate slow processing
		time.Sleep(50 * time.Millisecond)
	})

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	assert.Contains(t, output.String(), "...")
}

func TestCLIChannel_EmptyLine(t *testing.T) {
	cli, _ := setupCLI(t, "\n/quit\n")

	var called atomic.Bool
	cli.OnMessage(func(jid string, content string) {
		called.Store(true)
	})

	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	assert.False(t, called.Load(), "empty lines should not trigger message callback")
}

func TestCLIChannel_Disconnect(t *testing.T) {
	pr, pw := io.Pipe()
	var output bytes.Buffer
	cli := NewCLIChannel(pr, &output)

	require.NoError(t, cli.Connect())
	assert.True(t, cli.IsConnected())

	require.NoError(t, cli.Disconnect())
	assert.False(t, cli.IsConnected())

	// Cleanup
	pw.Close()
}

func TestCLIChannel_DoubleDisconnect(t *testing.T) {
	cli, _ := setupCLI(t, "/quit\n")
	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	// Second disconnect should not panic
	require.NoError(t, cli.Disconnect())
}

func TestCLIChannel_WelcomeBanner(t *testing.T) {
	cli, output := setupCLI(t, "/quit\n")
	require.NoError(t, cli.Connect())

	require.Eventually(t, func() bool {
		return !cli.IsConnected()
	}, 2*time.Second, 10*time.Millisecond)

	assert.Contains(t, output.String(), "OpenHive CLI")
}

func TestCLIChannel_OnMetadata(t *testing.T) {
	cli, _ := setupCLI(t, "")
	var called bool
	cli.OnMetadata(func(jid string, metadata map[string]string) {
		called = true
	})
	// Just verify it can be set without panic
	assert.False(t, called)
}
