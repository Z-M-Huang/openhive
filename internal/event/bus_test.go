package event

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewEventBus(t *testing.T) {
	bus := NewEventBus()
	require.NotNil(t, bus)
	assert.Empty(t, bus.subs)
}

func TestPublish_WithSubscriber(t *testing.T) {
	bus := NewEventBus()

	var received domain.Event
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		received = e
	})

	event := domain.Event{
		Type:    domain.EventTypeConfigChanged,
		Payload: "config updated",
	}
	bus.Publish(event)

	assert.Equal(t, domain.EventTypeConfigChanged, received.Type)
	assert.Equal(t, "config updated", received.Payload)
}

func TestPublish_NoSubscribers(t *testing.T) {
	bus := NewEventBus()

	// Should not panic when publishing with no subscribers
	bus.Publish(domain.Event{
		Type:    domain.EventTypeTaskCreated,
		Payload: "test",
	})
}

func TestPublish_MultipleSubscribers(t *testing.T) {
	bus := NewEventBus()

	var count atomic.Int32
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})

	assert.Equal(t, int32(2), count.Load())
}

func TestPublish_DifferentEventTypes(t *testing.T) {
	bus := NewEventBus()

	var configCalled, taskCalled bool
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		configCalled = true
	})
	bus.Subscribe(domain.EventTypeTaskCreated, func(e domain.Event) {
		taskCalled = true
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})

	assert.True(t, configCalled)
	assert.False(t, taskCalled)
}

func TestSubscribe_ReturnsUniqueIDs(t *testing.T) {
	bus := NewEventBus()

	id1 := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})
	id2 := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})

	assert.NotEmpty(t, id1)
	assert.NotEmpty(t, id2)
	assert.NotEqual(t, id1, id2)
}

func TestUnsubscribe(t *testing.T) {
	bus := NewEventBus()

	var count atomic.Int32
	id := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	assert.Equal(t, int32(1), count.Load())

	bus.Unsubscribe(id)

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	assert.Equal(t, int32(1), count.Load()) // Should not have incremented
}

func TestUnsubscribe_NonexistentID(t *testing.T) {
	bus := NewEventBus()
	// Should not panic
	bus.Unsubscribe("nonexistent-id")
}

func TestUnsubscribe_CleansUpEmptyMap(t *testing.T) {
	bus := NewEventBus()

	id := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})
	bus.Unsubscribe(id)

	bus.mu.RLock()
	_, exists := bus.subs[domain.EventTypeConfigChanged]
	bus.mu.RUnlock()
	assert.False(t, exists, "empty event type map should be cleaned up")
}

func TestConcurrentPublishSubscribe(t *testing.T) {
	bus := NewEventBus()
	var count atomic.Int32

	// Subscribe from multiple goroutines
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
				count.Add(1)
			})
		}()
	}
	wg.Wait()

	// Publish from multiple goroutines
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
		}()
	}
	wg.Wait()

	// Each of 5 publishes should have reached all 10 subscribers
	assert.Equal(t, int32(50), count.Load())
}

func TestAllEventTypes(t *testing.T) {
	bus := NewEventBus()

	types := []domain.EventType{
		domain.EventTypeTaskCreated,
		domain.EventTypeTaskUpdated,
		domain.EventTypeTaskCompleted,
		domain.EventTypeTaskFailed,
		domain.EventTypeConfigChanged,
		domain.EventTypeTeamCreated,
		domain.EventTypeTeamDeleted,
		domain.EventTypeAgentStarted,
		domain.EventTypeAgentStopped,
		domain.EventTypeChannelMessage,
	}

	for _, et := range types {
		var called bool
		bus.Subscribe(et, func(e domain.Event) {
			called = true
		})
		bus.Publish(domain.Event{Type: et})
		assert.True(t, called, "event type %v should trigger handler", et)
	}
}

// Verify InMemoryBus implements domain.EventBus interface.
var _ domain.EventBus = (*InMemoryBus)(nil)
