package orchestrator

import (
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestMonitor(t *testing.T, checkInterval, unhealthyTimeout time.Duration) *HeartbeatMonitorImpl {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))
	return NewHeartbeatMonitorWithIntervals(nil, logger, checkInterval, unhealthyTimeout)
}

func TestProcessHeartbeat_StoresStatusCorrectly(t *testing.T) {
	m := newTestMonitor(t, time.Second, 5*time.Second)

	agents := []domain.AgentHeartbeatStatus{
		{AID: "aid-001", Status: domain.AgentStatusIdle},
	}
	m.ProcessHeartbeat("team-001", agents)

	status, err := m.GetStatus("team-001")
	require.NoError(t, err)
	assert.Equal(t, "team-001", status.TeamID)
	assert.True(t, status.IsHealthy)
	assert.Equal(t, 1, len(status.Agents))
	assert.Equal(t, "aid-001", status.Agents[0].AID)
	assert.WithinDuration(t, time.Now(), status.LastSeen, time.Second)
}

func TestGetStatus_ReturnsNotFoundForUnknownTeam(t *testing.T) {
	m := newTestMonitor(t, time.Second, 5*time.Second)

	_, err := m.GetStatus("nonexistent-team")
	require.Error(t, err)
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
}

func TestGetAllStatuses_ReturnsAllTeams(t *testing.T) {
	m := newTestMonitor(t, time.Second, 5*time.Second)

	m.ProcessHeartbeat("team-alpha", []domain.AgentHeartbeatStatus{})
	m.ProcessHeartbeat("team-beta", []domain.AgentHeartbeatStatus{})
	m.ProcessHeartbeat("team-gamma", []domain.AgentHeartbeatStatus{})

	all := m.GetAllStatuses()
	assert.Len(t, all, 3)
	assert.Contains(t, all, "team-alpha")
	assert.Contains(t, all, "team-beta")
	assert.Contains(t, all, "team-gamma")
}

func TestUnhealthyDetection_TriggersCallbackAfterTimeout(t *testing.T) {
	// Use very short intervals for testing
	m := newTestMonitor(t, 10*time.Millisecond, 20*time.Millisecond)

	unhealthyCalled := make(chan string, 1)
	m.SetOnUnhealthy(func(teamID string) {
		unhealthyCalled <- teamID
	})

	// Inject a stale status to trigger the unhealthy check
	m.statuses.Store("team-stale", &domain.HeartbeatStatus{
		TeamID:    "team-stale",
		Agents:    nil,
		LastSeen:  time.Now().Add(-100 * time.Millisecond),
		IsHealthy: true,
	})

	m.StartMonitoring()
	defer m.StopMonitoring()

	select {
	case teamID := <-unhealthyCalled:
		assert.Equal(t, "team-stale", teamID)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("unhealthy callback was not called within timeout")
	}
}

func TestUnhealthyDetection_MarksStatusAsUnhealthy(t *testing.T) {
	m := newTestMonitor(t, 10*time.Millisecond, 20*time.Millisecond)
	m.SetOnUnhealthy(func(teamID string) {})

	// Inject an old heartbeat
	m.statuses.Store("team-old", &domain.HeartbeatStatus{
		TeamID:    "team-old",
		LastSeen:  time.Now().Add(-200 * time.Millisecond),
		IsHealthy: true,
	})

	m.StartMonitoring()
	defer m.StopMonitoring()

	// Wait for monitor to run
	time.Sleep(100 * time.Millisecond)

	status, err := m.GetStatus("team-old")
	require.NoError(t, err)
	assert.False(t, status.IsHealthy)
}

func TestHealthyAfterHeartbeat_ResetsUnhealthyTimer(t *testing.T) {
	m := newTestMonitor(t, 10*time.Millisecond, 20*time.Millisecond)

	unhealthyCount := 0
	m.SetOnUnhealthy(func(teamID string) {
		unhealthyCount++
	})

	// Start with stale status
	m.statuses.Store("team-recover", &domain.HeartbeatStatus{
		TeamID:    "team-recover",
		LastSeen:  time.Now().Add(-200 * time.Millisecond),
		IsHealthy: true,
	})

	m.StartMonitoring()
	defer m.StopMonitoring()

	time.Sleep(50 * time.Millisecond)

	// Send a fresh heartbeat — this should mark the team healthy again
	m.ProcessHeartbeat("team-recover", []domain.AgentHeartbeatStatus{})

	status, err := m.GetStatus("team-recover")
	require.NoError(t, err)
	// After fresh heartbeat, should be healthy again
	assert.True(t, status.IsHealthy)
}

func TestStopMonitoring_StopsTickerCleanly(t *testing.T) {
	m := newTestMonitor(t, 10*time.Millisecond, 50*time.Millisecond)
	m.StartMonitoring()
	time.Sleep(20 * time.Millisecond)
	m.StopMonitoring()

	// Calling stop multiple times should not panic
	m.StopMonitoring()
}

func TestUnhealthyDetection_PublishesEvent(t *testing.T) {
	published := make(chan domain.Event, 5)
	mockBus := &mockEventBus{publishFn: func(e domain.Event) { published <- e }}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))
	m := NewHeartbeatMonitorWithIntervals(mockBus, logger, 10*time.Millisecond, 20*time.Millisecond)

	// Inject stale status
	m.statuses.Store("team-pub", &domain.HeartbeatStatus{
		TeamID:    "team-pub",
		LastSeen:  time.Now().Add(-200 * time.Millisecond),
		IsHealthy: true,
	})

	m.StartMonitoring()
	defer m.StopMonitoring()

	var gotStateChange bool
	deadline := time.NewTimer(500 * time.Millisecond)
	defer deadline.Stop()
outer:
	for {
		select {
		case evt := <-published:
			if evt.Type == domain.EventTypeContainerStateChanged {
				gotStateChange = true
				break outer
			}
		case <-deadline.C:
			break outer
		}
	}
	assert.True(t, gotStateChange, "EventTypeContainerStateChanged should be published")
}

func TestConvertAgentStatuses(t *testing.T) {
	wsAgents := []ws.AgentStatus{
		{AID: "aid-001", Status: "idle", Detail: "waiting", ElapsedSeconds: 1.5, MemoryMB: 128.0},
		{AID: "aid-002", Status: "running", Detail: "processing", ElapsedSeconds: 5.0, MemoryMB: 256.0},
	}

	result := ConvertAgentStatuses(wsAgents)
	require.Len(t, result, 2)
	assert.Equal(t, "aid-001", result[0].AID)
	assert.Equal(t, domain.AgentStatusIdle, result[0].Status)
	assert.Equal(t, 1.5, result[0].ElapsedSeconds)
	assert.Equal(t, 128.0, result[0].MemoryMB)
	assert.Equal(t, "aid-002", result[1].AID)
}

// --- Mock EventBus ---

type mockEventBus struct {
	publishFn func(domain.Event)
}

func (m *mockEventBus) Publish(e domain.Event) {
	if m.publishFn != nil {
		m.publishFn(e)
	}
}
func (m *mockEventBus) Subscribe(eventType domain.EventType, handler func(domain.Event)) string {
	return ""
}
func (m *mockEventBus) FilteredSubscribe(eventType domain.EventType, filter func(domain.Event) bool, handler func(domain.Event)) string {
	return ""
}
func (m *mockEventBus) Unsubscribe(id string) {}
func (m *mockEventBus) Close()                {}
