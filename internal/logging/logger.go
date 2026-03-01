package logging

import (
	"context"
	"log/slog"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	batchSize     = 50
	flushInterval = 100 * time.Millisecond
	channelSize   = 1024
)

// DBLogger implements structured logging with dual output (DB + slog stdout),
// write batching, and sensitive field redaction.
type DBLogger struct {
	store    domain.LogStore
	minLevel domain.LogLevel
	redactor *Redactor
	slogger  *slog.Logger
	batchCh  chan *domain.LogEntry
	stopCh   chan struct{}
	doneCh   chan struct{}
}

// NewDBLogger creates a new DBLogger and starts the batch writer goroutine.
func NewDBLogger(
	store domain.LogStore,
	minLevel domain.LogLevel,
	slogger *slog.Logger,
) *DBLogger {
	l := &DBLogger{
		store:    store,
		minLevel: minLevel,
		redactor: NewRedactor(),
		slogger:  slogger,
		batchCh:  make(chan *domain.LogEntry, channelSize),
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
	go l.batchWriter()
	return l
}

// Log records a log entry, applying redaction and level filtering.
// The entry is sent to both the batch writer (for DB storage) and slog stdout.
// Sending is non-blocking; if the channel is full, the entry is dropped with a warning.
func (l *DBLogger) Log(entry *domain.LogEntry) {
	if entry.Level < l.minLevel {
		return
	}

	// Set timestamp if not already set
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
	}

	// Redact sensitive fields
	entry.Params = l.redactor.RedactParams(entry.Params)
	entry.Message = l.redactor.RedactString(entry.Message)

	// Output to slog
	l.slogOutput(entry)

	// Non-blocking send to batch writer
	select {
	case l.batchCh <- entry:
	default:
		l.slogger.Warn("log batch channel full, dropping entry",
			"component", entry.Component,
			"action", entry.Action,
		)
	}
}

func (l *DBLogger) slogOutput(entry *domain.LogEntry) {
	attrs := []slog.Attr{
		slog.String("component", entry.Component),
		slog.String("action", entry.Action),
	}
	if entry.TeamName != "" {
		attrs = append(attrs, slog.String("team", entry.TeamName))
	}
	if entry.TaskID != "" {
		attrs = append(attrs, slog.String("task_id", entry.TaskID))
	}
	if entry.AgentName != "" {
		attrs = append(attrs, slog.String("agent", entry.AgentName))
	}
	if entry.RequestID != "" {
		attrs = append(attrs, slog.String("request_id", entry.RequestID))
	}
	if entry.Error != "" {
		attrs = append(attrs, slog.String("error", entry.Error))
	}
	if entry.DurationMs > 0 {
		attrs = append(attrs, slog.Int64("duration_ms", entry.DurationMs))
	}

	args := make([]any, len(attrs))
	for i, a := range attrs {
		args[i] = a
	}

	switch entry.Level {
	case domain.LogLevelDebug:
		l.slogger.Debug(entry.Message, args...)
	case domain.LogLevelInfo:
		l.slogger.Info(entry.Message, args...)
	case domain.LogLevelWarn:
		l.slogger.Warn(entry.Message, args...)
	case domain.LogLevelError:
		l.slogger.Error(entry.Message, args...)
	default:
		l.slogger.Info(entry.Message, args...)
	}
}

// batchWriter accumulates entries and flushes to DB either when the batch is full
// or after the flush interval elapses.
func (l *DBLogger) batchWriter() {
	defer close(l.doneCh)

	batch := make([]*domain.LogEntry, 0, batchSize)
	timer := time.NewTimer(flushInterval)
	defer timer.Stop()

	for {
		select {
		case entry, ok := <-l.batchCh:
			if !ok {
				// Channel closed, flush remaining
				if len(batch) > 0 {
					l.flushBatch(batch)
				}
				return
			}
			batch = append(batch, entry)
			if len(batch) >= batchSize {
				l.flushBatch(batch)
				batch = batch[:0]
				timer.Reset(flushInterval)
			}
		case <-timer.C:
			if len(batch) > 0 {
				l.flushBatch(batch)
				batch = batch[:0]
			}
			timer.Reset(flushInterval)
		case <-l.stopCh:
			// Drain remaining entries from channel
			close(l.batchCh)
			for entry := range l.batchCh {
				batch = append(batch, entry)
			}
			if len(batch) > 0 {
				l.flushBatch(batch)
			}
			return
		}
	}
}

func (l *DBLogger) flushBatch(batch []*domain.LogEntry) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := l.store.Create(ctx, batch); err != nil {
		l.slogger.Error("failed to flush log batch to DB",
			"error", err,
			"count", len(batch),
		)
	}
}

// Stop signals the batch writer to flush remaining entries and shut down.
func (l *DBLogger) Stop() {
	close(l.stopCh)
	<-l.doneCh
}
