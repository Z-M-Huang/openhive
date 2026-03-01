package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

const (
	defaultMaxRetries     = 10
	defaultInitialBackoff = 1 * time.Second
	defaultMaxBackoff     = 60 * time.Second
)

// ChildProcessConfig holds configuration for the child process manager.
type ChildProcessConfig struct {
	// Command is the executable to run (e.g., "node")
	Command string
	// Args are the command arguments (e.g., ["agent-runner/dist/index.js", "--mode=master"])
	Args []string
	// Env contains additional environment variables to merge into the child
	// process environment. Keys and values are merged with os.Environ().
	Env map[string]string
	// Dir is the working directory for the child process
	Dir string
	// MaxRetries is the maximum number of restart attempts (default 10)
	MaxRetries int
	// InitialBackoff is the initial backoff duration (default 1s)
	InitialBackoff time.Duration
	// MaxBackoff is the maximum backoff duration (default 60s)
	MaxBackoff time.Duration
}

// ChildProcessManager manages the lifecycle of a Node.js child process,
// handling crash detection and restart with exponential backoff.
type ChildProcessManager struct {
	cfg      ChildProcessConfig
	logger   *slog.Logger
	cmd      *exec.Cmd
	mu       sync.Mutex
	retries  int
	running  bool
	stopCh   chan struct{}
	stopped  bool
	waitDone chan struct{} // closed when monitor goroutine exits
	onReady  func()
	cmdStart func(cmd *exec.Cmd) error // for testing
}

// NewChildProcessManager creates a new child process manager.
func NewChildProcessManager(cfg ChildProcessConfig, logger *slog.Logger) *ChildProcessManager {
	if cfg.MaxRetries == 0 {
		cfg.MaxRetries = defaultMaxRetries
	}
	if cfg.InitialBackoff == 0 {
		cfg.InitialBackoff = defaultInitialBackoff
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = defaultMaxBackoff
	}

	return &ChildProcessManager{
		cfg:      cfg,
		logger:   logger,
		stopCh:   make(chan struct{}),
		cmdStart: func(cmd *exec.Cmd) error { return cmd.Start() },
	}
}

// SetOnReady sets a callback invoked when the child process is started.
func (m *ChildProcessManager) SetOnReady(fn func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onReady = fn
}

// Start launches the child process and begins monitoring it.
func (m *ChildProcessManager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return nil
	}

	if err := m.startProcess(); err != nil {
		return fmt.Errorf("failed to start child process: %w", err)
	}

	m.running = true
	m.waitDone = make(chan struct{})
	go m.monitor(ctx)

	return nil
}

// Stop gracefully stops the child process and waits for the monitor
// goroutine to finish. Only killProcess sends the kill signal; the
// monitor goroutine is the sole owner of cmd.Wait() to avoid races.
func (m *ChildProcessManager) Stop() error {
	m.mu.Lock()

	if m.stopped {
		m.mu.Unlock()
		return nil
	}
	m.stopped = true
	m.running = false

	select {
	case <-m.stopCh:
	default:
		close(m.stopCh)
	}

	err := m.killProcess()
	waitDone := m.waitDone
	m.mu.Unlock()

	// Wait for the monitor goroutine to exit (it owns cmd.Wait).
	if waitDone != nil {
		<-waitDone
	}

	return err
}

// IsRunning returns whether the child process manager is actively running.
func (m *ChildProcessManager) IsRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// RetryCount returns the current retry count.
func (m *ChildProcessManager) RetryCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.retries
}

func (m *ChildProcessManager) startProcess() error {
	m.cmd = exec.Command(m.cfg.Command, m.cfg.Args...)
	if m.cfg.Dir != "" {
		m.cmd.Dir = m.cfg.Dir
	}
	if len(m.cfg.Env) > 0 {
		// Inherit the current process environment and merge extra vars.
		env := os.Environ()
		for k, v := range m.cfg.Env {
			env = append(env, k+"="+v)
		}
		m.cmd.Env = env
	}

	if err := m.cmdStart(m.cmd); err != nil {
		return fmt.Errorf("failed to start %s: %w", m.cfg.Command, err)
	}

	m.logger.Info("child process started",
		"command", m.cfg.Command,
		"pid", m.cmd.Process.Pid,
	)

	if m.onReady != nil {
		m.onReady()
	}

	return nil
}

func (m *ChildProcessManager) killProcess() error {
	if m.cmd == nil || m.cmd.Process == nil {
		return nil
	}

	if err := m.cmd.Process.Kill(); err != nil {
		m.logger.Warn("failed to kill child process", "error", err)
		return err
	}

	// Do NOT call cmd.Wait() here — the monitor goroutine is the sole
	// owner of Wait() to prevent data races. The monitor will reap the
	// process after Kill() causes Wait() to return.
	return nil
}

func (m *ChildProcessManager) monitor(ctx context.Context) {
	defer close(m.waitDone)

	for {
		// Wait for the process to exit. This goroutine is the sole caller
		// of cmd.Wait() to avoid data races with killProcess().
		err := m.cmd.Wait()

		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()

		if err != nil {
			m.logger.Error("child process crashed", "error", err)
		} else {
			m.logger.Warn("child process exited unexpectedly")
		}

		// Attempt restart
		if !m.restart(ctx) {
			return
		}
	}
}

func (m *ChildProcessManager) restart(ctx context.Context) bool {
	m.mu.Lock()
	m.retries++
	retries := m.retries
	maxRetries := m.cfg.MaxRetries
	m.mu.Unlock()

	if retries > maxRetries {
		m.logger.Error("max restart retries exceeded, giving up",
			"retries", retries,
			"max", maxRetries,
		)
		m.mu.Lock()
		m.running = false
		m.mu.Unlock()
		return false
	}

	// Calculate backoff: min(initialBackoff * 2^(retries-1), maxBackoff)
	backoff := m.cfg.InitialBackoff * time.Duration(1<<uint(retries-1))
	if backoff > m.cfg.MaxBackoff {
		backoff = m.cfg.MaxBackoff
	}

	m.logger.Info("restarting child process",
		"retry", retries,
		"max_retries", maxRetries,
		"backoff", backoff,
	)

	select {
	case <-time.After(backoff):
	case <-m.stopCh:
		return false
	case <-ctx.Done():
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.stopped {
		return false
	}

	if err := m.startProcess(); err != nil {
		m.logger.Error("failed to restart child process", "error", err)
		// Will retry again in the next loop iteration
		return true
	}

	return true
}
