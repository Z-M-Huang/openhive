package event

import (
	"log/slog"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/google/uuid"
)

const (
	defaultWorkers       = 10
	handlerTimeoutSecs   = 5
)

// InMemoryBus is an in-memory publish/subscribe event bus with async handlers,
// filtered subscriptions, and a bounded worker pool.
// It implements the domain.EventBus interface.
type InMemoryBus struct {
	mu         sync.RWMutex
	subs       map[domain.EventType]map[string]func(domain.Event)
	reverseMap map[string]domain.EventType
	workerCh   chan workerJob
	stopCh     chan struct{}
	wg         sync.WaitGroup
	maxWorkers int
	logger     *slog.Logger
}

type workerJob struct {
	handler func(domain.Event)
	event   domain.Event
}

// NewEventBus creates a new in-memory event bus with default settings.
func NewEventBus() *InMemoryBus {
	return NewEventBusWithWorkers(defaultWorkers, nil)
}

// NewEventBusWithWorkers creates a new event bus with a configurable worker pool size.
func NewEventBusWithWorkers(maxWorkers int, logger *slog.Logger) *InMemoryBus {
	if maxWorkers <= 0 {
		maxWorkers = defaultWorkers
	}
	b := &InMemoryBus{
		subs:       make(map[domain.EventType]map[string]func(domain.Event)),
		reverseMap: make(map[string]domain.EventType),
		workerCh:   make(chan workerJob, maxWorkers*10),
		stopCh:     make(chan struct{}),
		maxWorkers: maxWorkers,
		logger:     logger,
	}
	b.startWorkers()
	return b
}

func (b *InMemoryBus) startWorkers() {
	for i := 0; i < b.maxWorkers; i++ {
		b.wg.Add(1)
		go func() {
			defer b.wg.Done()
			for {
				select {
				case job, ok := <-b.workerCh:
					if !ok {
						return
					}
					b.runHandler(job.handler, job.event)
				case <-b.stopCh:
					return
				}
			}
		}()
	}
}

func (b *InMemoryBus) runHandler(handler func(domain.Event), event domain.Event) {
	// Run handler directly in the worker goroutine to prevent goroutine leaks.
	// A separate lightweight goroutine monitors for timeout and logs a warning.
	// If the handler blocks, it occupies one worker slot — bounded by pool size.
	done := make(chan struct{})
	timer := time.NewTimer(handlerTimeoutSecs * time.Second)
	go func() {
		defer timer.Stop()
		select {
		case <-done:
			// Handler completed before timeout — nothing to do.
		case <-timer.C:
			if b.logger != nil {
				b.logger.Warn("event handler exceeded timeout", "event_type", event.Type.String())
			}
		}
	}()

	handler(event)
	close(done)
}

// Publish sends an event to all subscribers of the event's type.
// Handlers are called asynchronously via a bounded worker pool.
func (b *InMemoryBus) Publish(event domain.Event) {
	b.mu.RLock()
	handlers := make([]func(domain.Event), 0)
	if subs, ok := b.subs[event.Type]; ok {
		for _, handler := range subs {
			handlers = append(handlers, handler)
		}
	}
	b.mu.RUnlock()

	for _, handler := range handlers {
		select {
		case b.workerCh <- workerJob{handler: handler, event: event}:
		case <-b.stopCh:
			return
		}
	}
}

// Subscribe registers a handler for a specific event type.
// Returns a subscription ID that can be used to unsubscribe.
func (b *InMemoryBus) Subscribe(eventType domain.EventType, handler func(domain.Event)) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if _, ok := b.subs[eventType]; !ok {
		b.subs[eventType] = make(map[string]func(domain.Event))
	}

	id := uuid.NewString()
	b.subs[eventType][id] = handler
	b.reverseMap[id] = eventType
	return id
}

// FilteredSubscribe registers a handler that only receives events matching the filter.
// Returns a subscription ID that can be used to unsubscribe.
func (b *InMemoryBus) FilteredSubscribe(eventType domain.EventType, filter func(domain.Event) bool, handler func(domain.Event)) string {
	wrapped := func(event domain.Event) {
		if filter == nil || filter(event) {
			handler(event)
		}
	}
	return b.Subscribe(eventType, wrapped)
}

// Unsubscribe removes a subscription by its ID using the reverse map for O(1) lookup.
func (b *InMemoryBus) Unsubscribe(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	eventType, ok := b.reverseMap[id]
	if !ok {
		return
	}

	delete(b.reverseMap, id)

	if subs, ok := b.subs[eventType]; ok {
		delete(subs, id)
		if len(subs) == 0 {
			delete(b.subs, eventType)
		}
	}
}

// Close drains the worker pool and waits for all in-flight handlers to complete.
func (b *InMemoryBus) Close() {
	close(b.stopCh)
	b.wg.Wait()
}
