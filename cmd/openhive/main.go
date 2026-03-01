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
	"github.com/Z-M-Huang/openhive/internal/crypto"
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

	km := crypto.NewManager()

	listenAddr := os.Getenv("OPENHIVE_SYSTEM_LISTEN_ADDRESS")
	if listenAddr == "" {
		listenAddr = "127.0.0.1:8080"
	}

	srv := api.NewServer(
		listenAddr,
		logger,
		km,
		spaFS,
		nil, // WebSocket handler registered in Issue #10
		nil, // CORS origins - will be configured from config
	)

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

	sig := <-sigCh
	logger.Info("received signal, shutting down", "signal", sig.String())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if shutdownErr := srv.Shutdown(ctx); shutdownErr != nil {
		logger.Error("shutdown error", "error", shutdownErr)
	}

	logger.Info("shutdown complete")
}
