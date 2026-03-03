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

// ServerDeps holds optional dependencies for the API server.
// All fields are optional; nil values disable the corresponding feature.
type ServerDeps struct {
	LogStore      domain.LogStore
	TaskStore     domain.TaskStore
	ConfigLoader  domain.ConfigLoader
	OrgChart      domain.OrgChart
	GoOrchestrator domain.GoOrchestrator
	HeartbeatMonitor domain.HeartbeatMonitor
	PortalWS      *PortalWSHandler
	DBLogger      DroppedLogCounter
	LogWriter     DBLogWriter
}

// NewServer creates a new API server with the given configuration and dependencies.
func NewServer(
	listenAddr string,
	logger *slog.Logger,
	km domain.KeyManager,
	spaFS fs.FS,
	wsHandler WSUpgradeHandler,
	chatHandler http.HandlerFunc,
	allowedOrigins []string,
	portalWS *PortalWSHandler,
	dbLogger DroppedLogCounter,
) *Server {
	return NewServerWithDeps(listenAddr, logger, km, spaFS, wsHandler, chatHandler, allowedOrigins, ServerDeps{
		PortalWS: portalWS,
		DBLogger: dbLogger,
	})
}

// NewServerWithDeps creates a new API server with full dependency injection.
func NewServerWithDeps(
	listenAddr string,
	logger *slog.Logger,
	km domain.KeyManager,
	spaFS fs.FS,
	wsHandler WSUpgradeHandler,
	chatHandler http.HandlerFunc,
	allowedOrigins []string,
	deps ServerDeps,
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
	r.Use(SecurityHeadersWithWS)
	r.Use(PanicRecovery(logger))
	r.Use(CORS(allowedOrigins))
	r.Use(Timing)
	r.Use(StructuredLogging(logger, deps.LogWriter))

	// API routes
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", HealthHandler(startTime, deps.DBLogger))
		r.Post("/auth/unlock", UnlockHandler(km))
		if chatHandler != nil {
			r.Post("/chat", chatHandler)
		}

		// Config and provider management
		if deps.ConfigLoader != nil {
			r.Get("/config", GetConfigHandler(deps.ConfigLoader, km, logger))
			r.Put("/config", PutConfigHandler(deps.ConfigLoader, logger))
			r.Get("/providers", GetProvidersHandler(deps.ConfigLoader, km, logger))
			r.Put("/providers", PutProvidersHandler(deps.ConfigLoader, km, logger))
		}

		// Log viewer
		if deps.LogStore != nil {
			r.Get("/logs", GetLogsHandler(deps.LogStore, logger))
		}

		// Team management
		if deps.OrgChart != nil {
			r.Get("/teams", GetTeamsHandler(deps.OrgChart, deps.HeartbeatMonitor, logger))
			r.Get("/teams/{slug}", GetTeamHandler(deps.OrgChart, deps.HeartbeatMonitor, logger))
		}
		if deps.GoOrchestrator != nil {
			r.Post("/teams", CreateTeamHandler(deps.GoOrchestrator, logger))
			r.Delete("/teams/{slug}", DeleteTeamHandler(deps.GoOrchestrator, logger))
		}

		// Task monitoring
		if deps.TaskStore != nil {
			r.Get("/tasks", GetTasksHandler(deps.TaskStore, logger))
			r.Get("/tasks/{id}", GetTaskHandler(deps.TaskStore, logger))
		}
		if deps.GoOrchestrator != nil && deps.TaskStore != nil {
			r.Post("/tasks/{id}/cancel", CancelTaskHandler(deps.GoOrchestrator, deps.TaskStore, logger))
		}

		// Portal WebSocket endpoint for real-time event streaming to web portal clients
		if deps.PortalWS != nil {
			r.HandleFunc("/ws", deps.PortalWS.HandleUpgrade)
		}
	})

	// WebSocket upgrade path for container connections (handler may be nil if ws package not initialized yet)
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

// Addr returns the configured listen address.
func (s *Server) Addr() string {
	if s.httpServer != nil {
		return s.httpServer.Addr
	}
	return ""
}
