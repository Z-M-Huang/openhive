package container

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	// Restart backoff steps for auto-restart.
	restartBackoff1 = 1 * time.Second
	restartBackoff2 = 5 * time.Second
	restartBackoff3 = 30 * time.Second

	// maxRestartAttempts before marking a container as errored.
	maxRestartAttempts = 3

	// defaultIdleTimeout is used when no idle timeout is configured.
	defaultIdleTimeout = 30 * time.Minute

	// stopTimeout is passed to ContainerStop for graceful shutdown.
	stopTimeout = 30 * time.Second
)

// WSHub is the subset of domain.WSHub used by the ManagerImpl.
type WSHub interface {
	GenerateToken(teamID string) (string, error)
	GetConnectedTeams() []string
}

// teamState tracks per-team runtime state.
type teamState struct {
	containerID   string
	restartCount  int
	idleTimer     *time.Timer
	cancelIdle    context.CancelFunc
}

// ManagerImpl implements domain.ContainerManager.
type ManagerImpl struct {
	runtime      domain.ContainerRuntime
	wsHub        WSHub
	configLoader domain.ConfigLoader
	logger       *slog.Logger
	wsURL        string // base WS URL e.g. "ws://go-backend:8080"

	// teamLocks provides per-team mutual exclusion to prevent concurrent
	// provision/remove races.
	teamLocks sync.Map // map[string]*sync.Mutex

	// states stores per-team runtime state.
	states sync.Map // map[string]*teamState

	// idleTimeout is the default idle duration if not set in team config.
	idleTimeout time.Duration
}

// ManagerConfig holds configuration for ManagerImpl.
type ManagerConfig struct {
	Runtime      domain.ContainerRuntime
	WSHub        WSHub
	ConfigLoader domain.ConfigLoader
	Logger       *slog.Logger
	WSURL        string
	IdleTimeout  time.Duration
}

// NewManager creates a new ManagerImpl.
func NewManager(cfg ManagerConfig) *ManagerImpl {
	idleTimeout := cfg.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultIdleTimeout
	}
	return &ManagerImpl{
		runtime:      cfg.Runtime,
		wsHub:        cfg.WSHub,
		configLoader: cfg.ConfigLoader,
		logger:       cfg.Logger,
		wsURL:        cfg.WSURL,
		idleTimeout:  idleTimeout,
	}
}

// teamLock returns (creating if needed) the per-team mutex.
func (m *ManagerImpl) teamLock(teamSlug string) *sync.Mutex {
	actual, _ := m.teamLocks.LoadOrStore(teamSlug, &sync.Mutex{})
	return actual.(*sync.Mutex)
}

// EnsureRunning starts the container for a team if it is not already running.
// Idempotent: safe to call multiple times.
func (m *ManagerImpl) EnsureRunning(ctx context.Context, teamSlug string) error {
	lock := m.teamLock(teamSlug)
	lock.Lock()
	defer lock.Unlock()

	// Check if a container is already running for this team.
	containers, err := m.runtime.ListContainers(ctx)
	if err != nil {
		return fmt.Errorf("ensure running %q: list containers: %w", teamSlug, err)
	}

	targetName := containerNamePrefix + teamSlug
	for _, c := range containers {
		if c.Name == targetName && c.State == domain.ContainerStateRunning {
			m.logger.Debug("container already running", "team_slug", teamSlug, "container_id", c.ID)
			m.updateContainerID(teamSlug, c.ID)
			return nil
		}
	}

	// Not running — provision it.
	return m.provision(ctx, teamSlug, nil)
}

// ProvisionTeam creates and starts a container for a team, passing provided secrets.
func (m *ManagerImpl) ProvisionTeam(ctx context.Context, teamSlug string, secrets map[string]string) error {
	lock := m.teamLock(teamSlug)
	lock.Lock()
	defer lock.Unlock()

	return m.provision(ctx, teamSlug, secrets)
}

// provision is the internal (lock-held) implementation of container provisioning.
func (m *ManagerImpl) provision(ctx context.Context, teamSlug string, secrets map[string]string) error {
	// Generate a WS token for this container.
	wsToken, err := m.wsHub.GenerateToken(teamSlug)
	if err != nil {
		return fmt.Errorf("provision %q: generate WS token: %w", teamSlug, err)
	}

	wsURL := fmt.Sprintf("%s/ws/container?token=%s", m.wsURL, wsToken)

	// Build env from secrets + WS connection vars.
	env := map[string]string{
		"WS_TOKEN": wsToken,
		"WS_URL":   wsURL,
	}
	for k, v := range secrets {
		env[k] = v
	}

	// Load team config for optional settings (memory, idle timeout).
	containerCfg := domain.ContainerConfig{
		Name: teamSlug,
		Env:  env,
	}

	if m.configLoader != nil {
		if team, loadErr := m.configLoader.LoadTeam(teamSlug); loadErr == nil && team != nil {
			containerCfg.MaxMemory = team.ContainerConfig.MaxMemory
			containerCfg.IdleTimeout = team.ContainerConfig.IdleTimeout
			// Merge any extra env vars from team config.
			for k, v := range team.ContainerConfig.Env {
				if _, exists := env[k]; !exists {
					env[k] = v
				}
			}
		}
	}

	containerID, createErr := m.runtime.CreateContainer(ctx, containerCfg)
	if createErr != nil {
		return fmt.Errorf("provision %q: create container: %w", teamSlug, createErr)
	}

	if startErr := m.runtime.StartContainer(ctx, containerID); startErr != nil {
		// Best-effort removal of the orphaned container.
		_ = m.runtime.RemoveContainer(ctx, containerID)
		return fmt.Errorf("provision %q: start container: %w", teamSlug, startErr)
	}

	m.logger.Info("container provisioned", "team_slug", teamSlug, "container_id", containerID)

	m.updateContainerID(teamSlug, containerID)
	m.resetRestartCount(teamSlug)
	m.resetIdleTimer(teamSlug)
	return nil
}

// RemoveTeam stops and removes the container for a team.
func (m *ManagerImpl) RemoveTeam(ctx context.Context, teamSlug string) error {
	lock := m.teamLock(teamSlug)
	lock.Lock()
	defer lock.Unlock()

	containerID, err := m.getContainerIDLocked(teamSlug)
	if err != nil {
		return err
	}

	m.cancelIdleTimer(teamSlug)

	if stopErr := m.runtime.StopContainer(ctx, containerID, stopTimeout); stopErr != nil {
		m.logger.Warn("stop container failed during remove", "team_slug", teamSlug, "error", stopErr)
	}

	if removeErr := m.runtime.RemoveContainer(ctx, containerID); removeErr != nil {
		return fmt.Errorf("remove team %q: %w", teamSlug, removeErr)
	}

	m.states.Delete(teamSlug)
	m.logger.Info("team container removed", "team_slug", teamSlug)
	return nil
}

// RestartTeam stops and starts the container for a team.
func (m *ManagerImpl) RestartTeam(ctx context.Context, teamSlug string) error {
	if err := m.StopTeam(ctx, teamSlug); err != nil {
		m.logger.Warn("stop failed during restart", "team_slug", teamSlug, "error", err)
	}
	return m.EnsureRunning(ctx, teamSlug)
}

// StopTeam gracefully stops the container without removing it.
func (m *ManagerImpl) StopTeam(ctx context.Context, teamSlug string) error {
	lock := m.teamLock(teamSlug)
	lock.Lock()
	defer lock.Unlock()

	containerID, err := m.getContainerIDLocked(teamSlug)
	if err != nil {
		return err
	}

	m.cancelIdleTimer(teamSlug)

	if stopErr := m.runtime.StopContainer(ctx, containerID, stopTimeout); stopErr != nil {
		return fmt.Errorf("stop team %q: %w", teamSlug, stopErr)
	}

	m.logger.Info("team container stopped", "team_slug", teamSlug)
	return nil
}

// Cleanup lists all openhive- containers and removes ones not tracked by config.
// This handles orphan containers left from a previous crash.
func (m *ManagerImpl) Cleanup(ctx context.Context) error {
	containers, err := m.runtime.ListContainers(ctx)
	if err != nil {
		return fmt.Errorf("cleanup: list containers: %w", err)
	}

	// Get configured team slugs.
	var configuredSlugs map[string]bool
	if m.configLoader != nil {
		slugs, listErr := m.configLoader.ListTeams()
		if listErr == nil {
			configuredSlugs = make(map[string]bool, len(slugs))
			for _, s := range slugs {
				configuredSlugs[s] = true
			}
		}
	}

	for _, c := range containers {
		// Extract slug from container name (strip "openhive-" prefix).
		if len(c.Name) <= len(containerNamePrefix) {
			continue
		}
		slug := c.Name[len(containerNamePrefix):]

		// If configLoader is available and slug is not configured, it's an orphan.
		if configuredSlugs != nil && !configuredSlugs[slug] {
			m.logger.Warn("removing orphan container", "container_name", c.Name, "container_id", c.ID)
			if stopErr := m.runtime.StopContainer(ctx, c.ID, stopTimeout); stopErr != nil {
				m.logger.Warn("stop orphan failed", "container_id", c.ID, "error", stopErr)
			}
			if removeErr := m.runtime.RemoveContainer(ctx, c.ID); removeErr != nil {
				m.logger.Error("remove orphan failed", "container_id", c.ID, "error", removeErr)
			}
		}
	}
	return nil
}

// GetStatus returns the current container state for a team.
func (m *ManagerImpl) GetStatus(teamSlug string) (domain.ContainerState, error) {
	containerID, err := m.GetContainerID(teamSlug)
	if err != nil {
		return domain.ContainerStateStopped, err
	}

	info, err := m.runtime.InspectContainer(context.Background(), containerID)
	if err != nil {
		return domain.ContainerStateError, fmt.Errorf("get status %q: %w", teamSlug, err)
	}
	return info.State, nil
}

// GetContainerID returns the Docker container ID for a team slug.
func (m *ManagerImpl) GetContainerID(teamSlug string) (string, error) {
	return m.getContainerIDLocked(teamSlug)
}

// HandleUnhealthy implements the auto-restart callback for the HeartbeatMonitor.
// Should be wired via monitor.SetOnUnhealthy(manager.HandleUnhealthy).
func (m *ManagerImpl) HandleUnhealthy(teamSlug string) {
	count := m.incrementRestartCount(teamSlug)

	if count > maxRestartAttempts {
		m.logger.Error("max restart attempts exceeded, container marked errored",
			"team_slug", teamSlug,
			"restart_count", count,
		)
		return
	}

	backoff := restartBackoffFor(count)
	m.logger.Warn("container unhealthy, scheduling restart",
		"team_slug", teamSlug,
		"attempt", count,
		"backoff", backoff,
	)

	go func() {
		time.Sleep(backoff)
		ctx := context.Background()
		if err := m.RestartTeam(ctx, teamSlug); err != nil {
			m.logger.Error("auto-restart failed",
				"team_slug", teamSlug,
				"attempt", count,
				"error", err,
			)
		} else {
			m.logger.Info("auto-restart succeeded", "team_slug", teamSlug, "attempt", count)
		}
	}()
}

// ResetRestartCount resets the restart counter for a team (called on successful heartbeat).
func (m *ManagerImpl) ResetRestartCount(teamSlug string) {
	m.resetRestartCount(teamSlug)
}

// ResetIdleTimer resets the idle timer for a team (called when a task is dispatched).
func (m *ManagerImpl) ResetIdleTimer(teamSlug string) {
	m.resetIdleTimer(teamSlug)
}

// --- internal helpers ---

func (m *ManagerImpl) updateContainerID(teamSlug, containerID string) {
	actual, _ := m.states.LoadOrStore(teamSlug, &teamState{})
	state := actual.(*teamState)
	state.containerID = containerID
}

func (m *ManagerImpl) getContainerIDLocked(teamSlug string) (string, error) {
	val, ok := m.states.Load(teamSlug)
	if !ok {
		return "", &domain.NotFoundError{Resource: "container", ID: teamSlug}
	}
	state := val.(*teamState)
	if state.containerID == "" {
		return "", &domain.NotFoundError{Resource: "container_id", ID: teamSlug}
	}
	return state.containerID, nil
}

func (m *ManagerImpl) incrementRestartCount(teamSlug string) int {
	actual, _ := m.states.LoadOrStore(teamSlug, &teamState{})
	state := actual.(*teamState)
	state.restartCount++
	return state.restartCount
}

func (m *ManagerImpl) resetRestartCount(teamSlug string) {
	actual, _ := m.states.LoadOrStore(teamSlug, &teamState{})
	state := actual.(*teamState)
	state.restartCount = 0
}

func (m *ManagerImpl) resetIdleTimer(teamSlug string) {
	actual, _ := m.states.LoadOrStore(teamSlug, &teamState{})
	state := actual.(*teamState)

	// Cancel existing idle timer if any.
	if state.cancelIdle != nil {
		state.cancelIdle()
	}

	ctx, cancel := context.WithCancel(context.Background())
	state.cancelIdle = cancel

	// Use per-team idle timeout if configured, otherwise fall back to manager default.
	timeout := m.idleTimeout
	if m.configLoader != nil {
		if team, loadErr := m.configLoader.LoadTeam(teamSlug); loadErr == nil && team != nil {
			if team.ContainerConfig.IdleTimeout != "" {
				if parsed, parseErr := time.ParseDuration(team.ContainerConfig.IdleTimeout); parseErr == nil && parsed > 0 {
					timeout = parsed
				}
			}
		}
	}

	go func() {
		select {
		case <-time.After(timeout):
			m.logger.Info("idle timeout reached, stopping container", "team_slug", teamSlug, "timeout", timeout)
			lock := m.teamLock(teamSlug)
			lock.Lock()
			defer lock.Unlock()

			containerID, err := m.getContainerIDLocked(teamSlug)
			if err != nil {
				return
			}
			if stopErr := m.runtime.StopContainer(context.Background(), containerID, stopTimeout); stopErr != nil {
				m.logger.Warn("idle timeout stop failed", "team_slug", teamSlug, "error", stopErr)
			}
		case <-ctx.Done():
			// Timer was cancelled (e.g., task dispatched, container stopped).
		}
	}()
}

func (m *ManagerImpl) cancelIdleTimer(teamSlug string) {
	if val, ok := m.states.Load(teamSlug); ok {
		state := val.(*teamState)
		if state.cancelIdle != nil {
			state.cancelIdle()
		}
	}
}

// restartBackoffFor returns the backoff duration for a given attempt number.
func restartBackoffFor(attempt int) time.Duration {
	switch attempt {
	case 1:
		return restartBackoff1
	case 2:
		return restartBackoff2
	default:
		return restartBackoff3
	}
}
