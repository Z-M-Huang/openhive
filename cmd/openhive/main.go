package main

import (
	"context"
	"embed"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Z-M-Huang/openhive/internal/api"
	"github.com/Z-M-Huang/openhive/internal/channel"
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/crypto"
	"github.com/Z-M-Huang/openhive/internal/orchestrator"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/Z-M-Huang/openhive/internal/ws"
)

//go:embed all:web_dist
var webDistFS embed.FS

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	spaFS, err := fs.Sub(webDistFS, "web_dist")
	if err != nil {
		logger.Error("failed to access embedded web assets", "error", err)
		os.Exit(1)
	}

	// Key manager for API key encryption
	km := crypto.NewManager()

	// Database
	db, err := store.NewDB("data/openhive.db")
	if err != nil {
		logger.Error("failed to open database", "error", err)
		os.Exit(1)
	}

	taskStore := store.NewTaskStore(db)
	sessionStore := store.NewSessionStore(db)

	// WebSocket hub
	wsHub := ws.NewHub(logger)

	// Task dispatcher
	dispatcher := orchestrator.NewDispatcher(taskStore, wsHub, logger)

	// Config loader
	dataDir := os.Getenv("OPENHIVE_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	cfgLoader, err := config.NewLoader(dataDir)
	if err != nil {
		logger.Error("failed to create config loader", "error", err)
		os.Exit(1)
	}

	// SDK tool handler with admin tools
	startTime := time.Now()
	toolHandler := orchestrator.NewToolHandler(logger)
	orchestrator.RegisterAdminTools(toolHandler, orchestrator.AdminToolsDeps{
		ConfigLoader: cfgLoader,
		KeyManager:   km,
		WSHub:        wsHub,
		StartTime:    startTime,
	})

	// Wire up WS message handler
	wsHub.SetOnMessage(dispatcher.HandleWSMessage)

	// Message router
	router := channel.NewRouter(channel.RouterConfig{
		WSHub:        wsHub,
		TaskStore:    taskStore,
		SessionStore: sessionStore,
		Logger:       logger,
		MainTeamID:   "main",
	})

	// CLI channel
	cliCh := channel.NewCLIChannel(os.Stdin, os.Stdout)
	if regErr := router.RegisterChannel(cliCh); regErr != nil {
		logger.Error("failed to register CLI channel", "error", regErr)
		os.Exit(1)
	}

	listenAddr := os.Getenv("OPENHIVE_SYSTEM_LISTEN_ADDRESS")
	if listenAddr == "" {
		listenAddr = "127.0.0.1:8080"
	}

	// HTTP server
	srv := api.NewServer(
		listenAddr,
		logger,
		km,
		spaFS,
		wsHub.HandleUpgrade,
		nil, // CORS origins - configured from config
	)

	// Child process manager for Node.js orchestrator
	childMgr := orchestrator.NewChildProcessManager(orchestrator.ChildProcessConfig{
		Command: "node",
		Args:    []string{"agent-runner/dist/index.js", "--mode=master"},
	}, logger)

	// Handle signals for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("OpenHive starting...", "addr", listenAddr)
		if startErr := srv.Start(); startErr != nil {
			logger.Error("server error", "error", startErr)
			os.Exit(1)
		}
	}()

	// Start child process manager
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if childErr := childMgr.Start(ctx); childErr != nil {
		logger.Warn("failed to start child process (may not be compiled yet)", "error", childErr)
	}

	// Connect CLI channel
	if connErr := cliCh.Connect(); connErr != nil {
		logger.Error("failed to connect CLI channel", "error", connErr)
	}

	sig := <-sigCh
	logger.Info("received signal, shutting down", "signal", sig.String())

	// Cleanup
	cancel()

	if stopErr := childMgr.Stop(); stopErr != nil {
		logger.Error("child process stop error", "error", stopErr)
	}

	_ = cliCh.Disconnect()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
		logger.Error("shutdown error", "error", shutdownErr)
	}

	// Suppress unused variable warnings by referencing components not yet fully wired
	_ = router
	_ = dispatcher
	_ = toolHandler

	logger.Info("shutdown complete")
}
