package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// Server wraps the HTTP server, router, and dependencies.
type Server struct {
	httpServer *http.Server
	router     chi.Router
	logger     *slog.Logger
	startTime  time.Time
}

// WSUpgradeHandler is the type for the WebSocket upgrade handler registered by the ws package.
type WSUpgradeHandler func(w http.ResponseWriter, r *http.Request)

// NewServer creates a new API server with the given configuration and dependencies.
func NewServer(
	listenAddr string,
	logger *slog.Logger,
	km domain.KeyManager,
	spaFS fs.FS,
	wsHandler WSUpgradeHandler,
	allowedOrigins []string,
) *Server {
	startTime := time.Now()
	r := chi.NewRouter()

	s := &Server{
		router:    r,
		logger:    logger,
		startTime: startTime,
	}

	// Middleware stack (order matters)
	r.Use(RequestID)
	r.Use(SecurityHeaders)
	r.Use(PanicRecovery(logger))
	r.Use(CORS(allowedOrigins))
	r.Use(Timing)
	r.Use(StructuredLogging(logger))

	// API routes
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", HealthHandler(startTime))
		r.Post("/auth/unlock", UnlockHandler(km))
	})

	// WebSocket upgrade path (handler may be nil if ws package not initialized yet)
	if wsHandler != nil {
		r.HandleFunc("/ws/container", http.HandlerFunc(wsHandler))
	}

	// SPA catch-all (must be last)
	if spaFS != nil {
		r.NotFound(SPAHandler(spaFS))
	} else {
		r.NotFound(NotFoundHandler())
	}

	s.httpServer = &http.Server{
		Addr:              listenAddr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	return s
}

// Start begins listening and serving HTTP requests.
func (s *Server) Start() error {
	s.logger.Info("starting HTTP server", "addr", s.httpServer.Addr)
	err := s.httpServer.ListenAndServe()
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Shutdown gracefully shuts down the server with the given context deadline.
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("shutting down HTTP server")
	return s.httpServer.Shutdown(ctx)
}

// Router returns the chi router for testing purposes.
func (s *Server) Router() chi.Router {
	return s.router
}
