package event

import (
	"sync"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/google/uuid"
)

// InMemoryBus is a simple in-memory publish/subscribe event bus.
// It implements the domain.EventBus interface.
type InMemoryBus struct {
	mu   sync.RWMutex
	subs map[domain.EventType]map[string]func(domain.Event)
}

// NewEventBus creates a new in-memory event bus.
func NewEventBus() *InMemoryBus {
	return &InMemoryBus{
		subs: make(map[domain.EventType]map[string]func(domain.Event)),
	}
}

// Publish sends an event to all subscribers of the event's type.
// Handlers are called synchronously in an unspecified order.
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
		handler(event)
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
	return id
}

// Unsubscribe removes a subscription by its ID.
func (b *InMemoryBus) Unsubscribe(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for eventType, subs := range b.subs {
		if _, ok := subs[id]; ok {
			delete(subs, id)
			if len(subs) == 0 {
				delete(b.subs, eventType)
			}
			return
		}
	}
}
