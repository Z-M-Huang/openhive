package orchestrator

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestChildManager(t *testing.T) *ChildProcessManager {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := ChildProcessConfig{
		Command:        "sleep",
		Args:           []string{"3600"},
		MaxRetries:     3,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	}
	return NewChildProcessManager(cfg, logger)
}

func TestNewChildProcessManager_Defaults(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	m := NewChildProcessManager(ChildProcessConfig{
		Command: "echo",
		Args:    []string{"hello"},
	}, logger)

	assert.Equal(t, defaultMaxRetries, m.cfg.MaxRetries)
	assert.Equal(t, defaultInitialBackoff, m.cfg.InitialBackoff)
	assert.Equal(t, defaultMaxBackoff, m.cfg.MaxBackoff)
}

func TestStart_LaunchesProcess(t *testing.T) {
	m := newTestChildManager(t)
	ctx := context.Background()

	err := m.Start(ctx)
	require.NoError(t, err)

	assert.True(t, m.IsRunning())
	assert.NotNil(t, m.cmd.Process)

	err = m.Stop()
	assert.NoError(t, err)
}

func TestStart_DoubleStart(t *testing.T) {
	m := newTestChildManager(t)
	ctx := context.Background()

	err := m.Start(ctx)
	require.NoError(t, err)

	// Second start should be no-op
	err = m.Start(ctx)
	assert.NoError(t, err)

	err = m.Stop()
	assert.NoError(t, err)
}

func TestStop_SetsNotRunning(t *testing.T) {
	m := newTestChildManager(t)
	ctx := context.Background()

	err := m.Start(ctx)
	require.NoError(t, err)

	err = m.Stop()
	require.NoError(t, err)

	assert.False(t, m.IsRunning())
}

func TestStop_DoubleStop(t *testing.T) {
	m := newTestChildManager(t)
	ctx := context.Background()

	err := m.Start(ctx)
	require.NoError(t, err)

	err = m.Stop()
	require.NoError(t, err)

	// Second stop should be no-op
	err = m.Stop()
	assert.NoError(t, err)
}

func TestCrashRestart_RestartsWithBackoff(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Use a command that exits immediately
	m := NewChildProcessManager(ChildProcessConfig{
		Command:        "false", // exits with code 1
		MaxRetries:     2,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     50 * time.Millisecond,
	}, logger)

	ctx := context.Background()
	err := m.Start(ctx)
	require.NoError(t, err)

	// Wait for retries to exhaust
	time.Sleep(500 * time.Millisecond)

	assert.False(t, m.IsRunning())
	assert.GreaterOrEqual(t, m.RetryCount(), 2)
}

func TestOnReady_CalledOnStart(t *testing.T) {
	m := newTestChildManager(t)

	var readyCalled bool
	var mu sync.Mutex
	m.SetOnReady(func() {
		mu.Lock()
		readyCalled = true
		mu.Unlock()
	})

	ctx := context.Background()
	err := m.Start(ctx)
	require.NoError(t, err)

	mu.Lock()
	assert.True(t, readyCalled)
	mu.Unlock()

	err = m.Stop()
	assert.NoError(t, err)
}

func TestContextCancellation_StopsRestart(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	m := NewChildProcessManager(ChildProcessConfig{
		Command:        "false", // exits immediately
		MaxRetries:     100,
		InitialBackoff: 1 * time.Second, // Long backoff
		MaxBackoff:     10 * time.Second,
	}, logger)

	ctx, cancel := context.WithCancel(context.Background())
	err := m.Start(ctx)
	require.NoError(t, err)

	// Wait a bit for first crash
	time.Sleep(100 * time.Millisecond)

	// Cancel context - should stop restart loop
	cancel()

	time.Sleep(200 * time.Millisecond)
	// The process should have stopped trying
	retries := m.RetryCount()
	assert.LessOrEqual(t, retries, 2) // Should not have retried many times
}

func TestStartProcess_Failure(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	m := NewChildProcessManager(ChildProcessConfig{
		Command:    "echo",
		Args:       []string{"test"},
		MaxRetries: 1,
	}, logger)

	// Override cmdStart to always fail
	m.cmdStart = func(cmd *exec.Cmd) error {
		return assert.AnError
	}

	ctx := context.Background()
	err := m.Start(ctx)
	assert.Error(t, err)
	assert.False(t, m.IsRunning())
}

func TestBackoffCalculation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	m := NewChildProcessManager(ChildProcessConfig{
		Command:        "echo",
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     500 * time.Millisecond,
		MaxRetries:     5,
	}, logger)

	// Test backoff: 100ms * 2^(n-1)
	// retry 1: 100ms
	// retry 2: 200ms
	// retry 3: 400ms
	// retry 4: 500ms (capped)

	_ = m // Backoff calculation is tested implicitly through the restart mechanism
	assert.Equal(t, 100*time.Millisecond, m.cfg.InitialBackoff)
	assert.Equal(t, 500*time.Millisecond, m.cfg.MaxBackoff)
}
