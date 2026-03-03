package api

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/google/uuid"
)

type contextKey string

const requestIDKey contextKey = "request_id"

// RequestIDFromContext returns the request ID from the context, or empty string if not set.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// RequestID generates a unique request ID and attaches it to the request context.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := uuid.New().String()
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SecurityHeaders adds security headers to all responses.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersWithWS adds security headers with WebSocket and Tailwind support.
// Use this variant for servers that serve the React SPA.
func SecurityHeadersWithWS(next http.Handler) http.Handler {
	// CSP allows:
	//   - default-src 'self': only same-origin by default
	//   - style-src 'self' 'unsafe-inline': Tailwind injects inline styles
	//   - connect-src 'self' ws: wss:: WebSocket connections for portal event stream
	//   - img-src 'self' data:: data: URIs for inline icons
	const csp = "default-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"connect-src 'self' ws: wss:; " +
		"img-src 'self' data:"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", csp)
		next.ServeHTTP(w, r)
	})
}

// responseRecorder wraps http.ResponseWriter to capture the status code.
type responseRecorder struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func newResponseRecorder(w http.ResponseWriter) *responseRecorder {
	return &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rr *responseRecorder) WriteHeader(code int) {
	if !rr.written {
		rr.statusCode = code
		rr.written = true
	}
	rr.ResponseWriter.WriteHeader(code)
}

func (rr *responseRecorder) Write(b []byte) (int, error) {
	if !rr.written {
		rr.written = true
	}
	return rr.ResponseWriter.Write(b)
}

// Hijack implements http.Hijacker, required for WebSocket upgrade support.
// Delegates to the underlying ResponseWriter if it supports hijacking.
func (rr *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := rr.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker")
}

// Timing logs the request duration and adds it to the X-Response-Time header.
func Timing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := newResponseRecorder(w)
		next.ServeHTTP(rec, r)
		duration := time.Since(start)
		rec.ResponseWriter.Header().Set("X-Response-Time", duration.String())
	})
}

// DBLogWriter can record structured log entries to a persistent store.
type DBLogWriter interface {
	Log(entry *domain.LogEntry)
}

// StructuredLogging logs requests with slog and optionally writes to a DB logger.
// If dbLogger is nil, only slog output is produced.
func StructuredLogging(logger *slog.Logger, dbLogger DBLogWriter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := newResponseRecorder(w)
			next.ServeHTTP(rec, r)
			duration := time.Since(start)

			reqID := RequestIDFromContext(r.Context())
			logger.Info("http request",
				"request_id", reqID,
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.statusCode,
				"duration", duration.String(),
			)

			if dbLogger != nil {
				level := domain.LogLevelInfo
				if rec.statusCode >= 500 {
					level = domain.LogLevelError
				} else if rec.statusCode >= 400 {
					level = domain.LogLevelWarn
				}
				dbLogger.Log(&domain.LogEntry{
					Level:      level,
					Component:  "api",
					Action:     r.Method + " " + r.URL.Path,
					Message:    fmt.Sprintf("%s %s %d", r.Method, r.URL.Path, rec.statusCode),
					RequestID:  reqID,
					DurationMs: duration.Milliseconds(),
					CreatedAt:  start,
				})
			}
		})
	}
}

// CORS handles Cross-Origin Resource Sharing with strict origin checking.
func CORS(allowedOrigins []string) func(http.Handler) http.Handler {
	originSet := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[strings.TrimSpace(o)] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if origin != "" && originSet[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}

			if r.Method == http.MethodOptions && origin != "" && originSet[origin] {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// PanicRecovery recovers from panics, logs the stack trace, and returns a 500 JSON error.
func PanicRecovery(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					stack := debug.Stack()
					reqID := RequestIDFromContext(r.Context())
					logger.Error("panic recovered",
						"request_id", reqID,
						"panic", rec,
						"stack", string(stack),
					)
					Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "an internal error occurred")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
