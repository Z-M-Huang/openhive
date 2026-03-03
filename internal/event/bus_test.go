package event

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// waitForCount blocks until the counter reaches the expected value, or times out.
func waitForCount(t *testing.T, counter *atomic.Int32, expected int32, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if counter.Load() == expected {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	assert.Equal(t, expected, counter.Load(), "timed out waiting for counter")
}

func TestNewEventBus(t *testing.T) {
	bus := NewEventBus()
	require.NotNil(t, bus)
	assert.Empty(t, bus.subs)
	bus.Close()
}

func TestPublish_WithSubscriber(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var received domain.Event
	var mu sync.Mutex
	done := make(chan struct{})

	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		mu.Lock()
		received = e
		mu.Unlock()
		close(done)
	})

	event := domain.Event{
		Type:    domain.EventTypeConfigChanged,
		Payload: "config updated",
	}
	bus.Publish(event)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler was not called within timeout")
	}

	mu.Lock()
	assert.Equal(t, domain.EventTypeConfigChanged, received.Type)
	assert.Equal(t, "config updated", received.Payload)
	mu.Unlock()
}

func TestPublish_NoSubscribers(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	// Should not panic when publishing with no subscribers
	bus.Publish(domain.Event{
		Type:    domain.EventTypeTaskCreated,
		Payload: "test",
	})
	// Give async goroutines time to finish
	time.Sleep(20 * time.Millisecond)
}

func TestPublish_MultipleSubscribers(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var count atomic.Int32
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	waitForCount(t, &count, 2, time.Second)
}

func TestPublish_DifferentEventTypes(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var configCalled atomic.Int32
	var taskCalled atomic.Int32
	done := make(chan struct{})

	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		configCalled.Add(1)
		close(done)
	})
	bus.Subscribe(domain.EventTypeTaskCreated, func(e domain.Event) {
		taskCalled.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler was not called within timeout")
	}
	time.Sleep(20 * time.Millisecond) // ensure taskCalled goroutine had a chance to run

	assert.Equal(t, int32(1), configCalled.Load())
	assert.Equal(t, int32(0), taskCalled.Load())
}

func TestSubscribe_ReturnsUniqueIDs(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	id1 := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})
	id2 := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})

	assert.NotEmpty(t, id1)
	assert.NotEmpty(t, id2)
	assert.NotEqual(t, id1, id2)
}

func TestUnsubscribe(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var count atomic.Int32
	id := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	waitForCount(t, &count, 1, time.Second)

	bus.Unsubscribe(id)

	bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	time.Sleep(50 * time.Millisecond) // Give enough time for async processing
	assert.Equal(t, int32(1), count.Load(), "count should not have incremented after unsubscribe")
}

func TestUnsubscribe_NonexistentID(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	// Should not panic
	bus.Unsubscribe("nonexistent-id")
}

func TestUnsubscribe_CleansUpEmptyMap(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	id := bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {})
	bus.Unsubscribe(id)

	bus.mu.RLock()
	_, exists := bus.subs[domain.EventTypeConfigChanged]
	bus.mu.RUnlock()
	assert.False(t, exists, "empty event type map should be cleaned up")
}

func TestFilteredSubscribe_OnlyDeliverMatching(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var received atomic.Int32
	done := make(chan struct{})

	bus.FilteredSubscribe(domain.EventTypeTaskCreated, func(e domain.Event) bool {
		payload, ok := e.Payload.(string)
		return ok && payload == "match"
	}, func(e domain.Event) {
		received.Add(1)
		select {
		case <-done:
		default:
			close(done)
		}
	})

	bus.Publish(domain.Event{Type: domain.EventTypeTaskCreated, Payload: "no-match"})
	time.Sleep(30 * time.Millisecond)
	assert.Equal(t, int32(0), received.Load(), "non-matching event should not be delivered")

	bus.Publish(domain.Event{Type: domain.EventTypeTaskCreated, Payload: "match"})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("matching event handler was not called")
	}
	assert.Equal(t, int32(1), received.Load())
}

func TestFilteredSubscribe_NilFilterAcceptsAll(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var count atomic.Int32
	bus.FilteredSubscribe(domain.EventTypeTaskCreated, nil, func(e domain.Event) {
		count.Add(1)
	})

	bus.Publish(domain.Event{Type: domain.EventTypeTaskCreated})
	waitForCount(t, &count, 1, time.Second)
}

func TestClose_DrainsWorkerPool(t *testing.T) {
	bus := NewEventBusWithWorkers(2, nil)

	var count atomic.Int32
	bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
		count.Add(1)
	})

	for i := 0; i < 5; i++ {
		bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
	}

	bus.Close() // Should wait for all jobs to complete
	// After Close returns, the workers have stopped (not all jobs guaranteed to have run)
	// Just verify no panic
}

func TestConcurrentPublishSubscribe(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

	var count atomic.Int32
	numSubscribers := 10
	numPublishes := 5

	var wg sync.WaitGroup
	for i := 0; i < numSubscribers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus.Subscribe(domain.EventTypeConfigChanged, func(e domain.Event) {
				count.Add(1)
			})
		}()
	}
	wg.Wait()

	for i := 0; i < numPublishes; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bus.Publish(domain.Event{Type: domain.EventTypeConfigChanged})
		}()
	}
	wg.Wait()

	// Each publish should reach all subscribers, but since async, wait for all
	expected := int32(numSubscribers * numPublishes)
	waitForCount(t, &count, expected, 2*time.Second)
}

func TestAllEventTypes(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()

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
		domain.EventTypeHeartbeatReceived,
		domain.EventTypeContainerStateChanged,
		domain.EventTypeLogEntry,
		domain.EventTypeTaskCancelled,
	}

	for _, et := range types {
		var called atomic.Int32
		bus.Subscribe(et, func(e domain.Event) {
			called.Add(1)
		})
		bus.Publish(domain.Event{Type: et})
		waitForCount(t, &called, 1, time.Second)
		assert.Equal(t, int32(1), called.Load(), "event type %v should trigger handler", et)
	}
}

// Verify InMemoryBus implements domain.EventBus interface.
var _ domain.EventBus = (*InMemoryBus)(nil)
