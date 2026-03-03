package orchestrator

import (
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
)

const (
	defaultCheckInterval    = 30 * time.Second
	defaultUnhealthyTimeout = 90 * time.Second
	// Jitter spreads health checks to avoid thundering herd with many containers.
	maxJitter = 5 * time.Second
)

// HeartbeatMonitorImpl implements domain.HeartbeatMonitor.
type HeartbeatMonitorImpl struct {
	statuses         sync.Map // map[string]*domain.HeartbeatStatus
	onUnhealthy      func(teamID string)
	onUnhealthyMu    sync.Mutex
	eventBus         domain.EventBus
	logger           *slog.Logger
	checkInterval    time.Duration
	unhealthyTimeout time.Duration
	jitter           time.Duration
	stopCh           chan struct{}
	once             sync.Once
}

// NewHeartbeatMonitor creates a new HeartbeatMonitor with default intervals and jitter.
func NewHeartbeatMonitor(eventBus domain.EventBus, logger *slog.Logger) *HeartbeatMonitorImpl {
	return &HeartbeatMonitorImpl{
		eventBus:         eventBus,
		logger:           logger,
		checkInterval:    defaultCheckInterval,
		unhealthyTimeout: defaultUnhealthyTimeout,
		jitter:           maxJitter,
		stopCh:           make(chan struct{}),
	}
}

// NewHeartbeatMonitorWithIntervals creates a monitor with custom intervals for testing.
// Jitter is disabled (zero) when called with this constructor to keep tests deterministic.
func NewHeartbeatMonitorWithIntervals(eventBus domain.EventBus, logger *slog.Logger, checkInterval, unhealthyTimeout time.Duration) *HeartbeatMonitorImpl {
	return &HeartbeatMonitorImpl{
		eventBus:         eventBus,
		logger:           logger,
		checkInterval:    checkInterval,
		unhealthyTimeout: unhealthyTimeout,
		jitter:           0, // no jitter in tests
		stopCh:           make(chan struct{}),
	}
}

// ProcessHeartbeat records a heartbeat for the given team. Updates statuses and
// publishes an EventTypeHeartbeatReceived event.
func (h *HeartbeatMonitorImpl) ProcessHeartbeat(teamID string, agents []domain.AgentHeartbeatStatus) {
	now := time.Now()

	status := &domain.HeartbeatStatus{
		TeamID:    teamID,
		Agents:    agents,
		LastSeen:  now,
		IsHealthy: true,
	}

	h.statuses.Store(teamID, status)

	h.logger.Debug("heartbeat processed", "team_id", teamID, "agent_count", len(agents))

	if h.eventBus != nil {
		h.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeHeartbeatReceived,
			Payload: status,
		})
	}
}

// GetStatus returns the latest heartbeat status for a team.
func (h *HeartbeatMonitorImpl) GetStatus(teamID string) (*domain.HeartbeatStatus, error) {
	val, ok := h.statuses.Load(teamID)
	if !ok {
		return nil, &domain.NotFoundError{Resource: "heartbeat_status", ID: teamID}
	}
	return val.(*domain.HeartbeatStatus), nil
}

// GetAllStatuses returns a snapshot of all team statuses.
func (h *HeartbeatMonitorImpl) GetAllStatuses() map[string]*domain.HeartbeatStatus {
	result := make(map[string]*domain.HeartbeatStatus)
	h.statuses.Range(func(key, value interface{}) bool {
		result[key.(string)] = value.(*domain.HeartbeatStatus)
		return true
	})
	return result
}

// SetOnUnhealthy registers a callback to invoke when a team becomes unhealthy.
func (h *HeartbeatMonitorImpl) SetOnUnhealthy(callback func(teamID string)) {
	h.onUnhealthyMu.Lock()
	defer h.onUnhealthyMu.Unlock()
	h.onUnhealthy = callback
}

// StartMonitoring begins the background health-check ticker.
// Safe to call multiple times; only the first call takes effect.
func (h *HeartbeatMonitorImpl) StartMonitoring() {
	h.once.Do(func() {
		go h.monitorLoop()
	})
}

// StopMonitoring stops the background health-check ticker.
func (h *HeartbeatMonitorImpl) StopMonitoring() {
	select {
	case <-h.stopCh:
		// already stopped
	default:
		close(h.stopCh)
	}
}

// monitorLoop runs the periodic health-check.
func (h *HeartbeatMonitorImpl) monitorLoop() {
	// Apply startup jitter to spread checks across restarts.
	// Jitter is 0 in test mode for determinism.
	var jitter time.Duration
	if h.jitter > 0 {
		jitter = time.Duration(rand.Int63n(int64(h.jitter)))
	}
	select {
	case <-time.After(jitter):
	case <-h.stopCh:
		return
	}

	ticker := time.NewTicker(h.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			h.checkHealth()
		case <-h.stopCh:
			return
		}
	}
}

// checkHealth inspects all known team statuses and marks stale ones as unhealthy.
func (h *HeartbeatMonitorImpl) checkHealth() {
	now := time.Now()
	h.statuses.Range(func(key, value interface{}) bool {
		teamID := key.(string)
		status := value.(*domain.HeartbeatStatus)

		if now.Sub(status.LastSeen) > h.unhealthyTimeout {
			if status.IsHealthy {
				// Transition from healthy to unhealthy
				updated := *status
				updated.IsHealthy = false
				h.statuses.Store(teamID, &updated)

				h.logger.Warn("container heartbeat timeout",
					"team_id", teamID,
					"last_seen", status.LastSeen,
					"threshold", h.unhealthyTimeout,
				)

				h.onUnhealthyMu.Lock()
				cb := h.onUnhealthy
				h.onUnhealthyMu.Unlock()

				if cb != nil {
					cb(teamID)
				}

				if h.eventBus != nil {
					h.eventBus.Publish(domain.Event{
						Type: domain.EventTypeContainerStateChanged,
						Payload: map[string]interface{}{
							"team_id": teamID,
							"state":   "unhealthy",
						},
					})
				}
			}
		}
		return true
	})
}

// InjectStaleStatus backdates the LastSeen for a team to force unhealthy detection.
// Used only in tests — do not call from production code.
func (h *HeartbeatMonitorImpl) InjectStaleStatus(teamID string) {
	val, ok := h.statuses.Load(teamID)
	if !ok {
		return
	}
	status := val.(*domain.HeartbeatStatus)
	updated := *status
	updated.LastSeen = time.Now().Add(-2 * h.unhealthyTimeout)
	h.statuses.Store(teamID, &updated)
}

// ConvertAgentStatuses converts ws.AgentStatus slice to domain.AgentHeartbeatStatus slice.
func ConvertAgentStatuses(wsAgents []ws.AgentStatus) []domain.AgentHeartbeatStatus {
	result := make([]domain.AgentHeartbeatStatus, len(wsAgents))
	for i, a := range wsAgents {
		statusType, _ := domain.ParseAgentStatusType(a.Status)
		result[i] = domain.AgentHeartbeatStatus{
			AID:            a.AID,
			Status:         statusType,
			Detail:         a.Detail,
			ElapsedSeconds: a.ElapsedSeconds,
			MemoryMB:       a.MemoryMB,
		}
	}
	return result
}
