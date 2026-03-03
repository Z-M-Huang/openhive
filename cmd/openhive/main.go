package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Z-M-Huang/openhive/internal/api"
	"github.com/Z-M-Huang/openhive/internal/channel"
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/container"
	"github.com/Z-M-Huang/openhive/internal/crypto"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/event"
	"github.com/Z-M-Huang/openhive/internal/logging"
	"github.com/Z-M-Huang/openhive/internal/orchestrator"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/Z-M-Huang/openhive/internal/ws"
)

//go:embed all:web_dist
var webDistFS embed.FS

// App holds all application components and their wiring.
type App struct {
	logger *slog.Logger
	spaFS  fs.FS

	// Stores
	db           *store.DB
	taskStore    domain.TaskStore
	sessionStore domain.SessionStore
	messageStore domain.MessageStore
	logStore     domain.LogStore

	// Infrastructure
	km        *crypto.Manager
	wsHub     *ws.Hub
	eventBus  domain.EventBus
	dbLogger  *logging.DBLogger

	// Config
	cfgLoader domain.ConfigLoader
	orgChart  domain.OrgChart
	masterCfg *domain.MasterConfig
	providers map[string]domain.Provider

	// Orchestration
	dispatcher       *orchestrator.Dispatcher
	toolHandler      *orchestrator.ToolHandler
	heartbeatMonitor domain.HeartbeatMonitor
	containerManager domain.ContainerManager
	goOrch           *orchestrator.GoOrchestratorImpl
	childMgr         *orchestrator.ChildProcessManager

	// Channels
	router    *channel.Router
	apiCh     *channel.APIChannel
	discordCh *channel.DiscordChannel
	waCh      *channel.WhatsAppChannel

	// HTTP
	apiServer *api.Server
	portalWS  *api.PortalWSHandler

	// Log & message archivers
	logArchiver     *logging.Archiver
	msgArchiverStop chan struct{}
	msgArchiverDone chan struct{}
}

func main() {
	// Use LevelVar so log level can be updated after config loads and at runtime.
	logLevel := new(slog.LevelVar)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))

	spaFS, err := fs.Sub(webDistFS, "web_dist")
	if err != nil {
		logger.Error("failed to access embedded web assets", "error", err)
		os.Exit(1)
	}

	app := &App{
		logger: logger,
		spaFS:  spaFS,
	}

	if err := app.Build(logLevel); err != nil {
		logger.Error("failed to build application", "error", err)
		os.Exit(1)
	}

	// Handle signals for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("OpenHive starting...", "addr", app.listenAddr())
		if startErr := app.apiServer.Start(); startErr != nil {
			logger.Error("server error", "error", startErr)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := app.Start(ctx); err != nil {
		logger.Warn("start error (non-fatal)", "error", err)
	}

	sig := <-sigCh
	logger.Info("received signal, shutting down", "signal", sig.String())

	cancel()
	app.Shutdown()
}

// Build creates all application components in dependency order.
func (a *App) Build(logLevel *slog.LevelVar) error {
	// Key manager for API key encryption
	a.km = crypto.NewManager()

	// Runtime directory (database, workspaces, archives — writable ephemeral state).
	runDir := os.Getenv("OPENHIVE_RUN_DIR")
	if runDir == "" {
		runDir = "data" // backward compat: default to data/ for local dev without Docker
	}
	if err := os.MkdirAll(runDir, 0755); err != nil {
		return fmt.Errorf("failed to create run dir %s: %w", runDir, err)
	}

	// Database
	dbPath := filepath.Join(runDir, "openhive.db")
	db, err := store.NewDB(dbPath)
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}
	a.db = db

	a.taskStore = store.NewTaskStore(db)
	a.sessionStore = store.NewSessionStore(db)
	a.messageStore = store.NewMessageStore(db)
	a.logStore = store.NewLogStore(db)

	// DB-backed structured logger
	a.dbLogger = logging.NewDBLogger(a.logStore, domain.LogLevelInfo, a.logger)

	// Config loader
	dataDir := os.Getenv("OPENHIVE_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	cfgLoader, err := config.NewLoader(dataDir, runDir)
	if err != nil {
		return fmt.Errorf("failed to create config loader: %w", err)
	}
	a.cfgLoader = cfgLoader

	// Wire key manager to config loader for auto-encryption of channel tokens.
	cfgLoader.SetKeyManager(a.km)

	// Unlock the key manager if OPENHIVE_MASTER_KEY is set.
	if masterKey := os.Getenv("OPENHIVE_MASTER_KEY"); masterKey != "" {
		if unlockErr := a.km.Unlock(masterKey); unlockErr != nil {
			a.logger.Warn("failed to unlock key manager from OPENHIVE_MASTER_KEY", "error", unlockErr)
		} else {
			a.logger.Info("key manager unlocked from environment variable")
		}
	}

	// Load master config
	masterCfg, err := cfgLoader.LoadMaster()
	if err != nil {
		return fmt.Errorf("failed to load master config: %w", err)
	}
	a.masterCfg = masterCfg

	// Apply configured log level
	applyLogLevel(logLevel, masterCfg.System.LogLevel)
	a.logger.Info("log level set", "level", masterCfg.System.LogLevel)

	// Load providers
	providers, err := cfgLoader.LoadProviders()
	if err != nil {
		return fmt.Errorf("failed to load providers config: %w", err)
	}
	a.providers = providers

	// Event bus for system-wide pub/sub
	a.eventBus = event.NewEventBus()

	// Wire config watcher to publish events on config changes.
	if watchErr := cfgLoader.WatchMaster(func(cfg *domain.MasterConfig) {
		applyLogLevel(logLevel, cfg.System.LogLevel)
		a.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeConfigChanged,
			Payload: cfg,
		})
		a.logger.Info("master config changed, published event", "log_level", cfg.System.LogLevel)
	}); watchErr != nil {
		a.logger.Warn("failed to watch master config", "error", watchErr)
	}

	// OrgChart — wire to ConfigChanged events
	orgChartSvc := config.NewOrgChart()
	a.orgChart = orgChartSvc
	a.eventBus.Subscribe(domain.EventTypeConfigChanged, func(evt domain.Event) {
		cfg, ok := evt.Payload.(*domain.MasterConfig)
		if !ok {
			return
		}
		slugs, listErr := cfgLoader.ListTeams()
		if listErr != nil {
			a.logger.Warn("failed to list teams for orgchart rebuild", "error", listErr)
			return
		}
		teams := make(map[string]*domain.Team, len(slugs))
		for _, slug := range slugs {
			team, loadErr := cfgLoader.LoadTeam(slug)
			if loadErr != nil {
				continue
			}
			teams[slug] = team
		}
		if rebuildErr := orgChartSvc.RebuildFromConfig(cfg, teams); rebuildErr != nil {
			a.logger.Warn("failed to rebuild orgchart on config change", "error", rebuildErr)
		}
	})

	// Initial OrgChart build
	{
		slugs, _ := cfgLoader.ListTeams()
		teams := make(map[string]*domain.Team, len(slugs))
		for _, slug := range slugs {
			if team, loadErr := cfgLoader.LoadTeam(slug); loadErr == nil {
				teams[slug] = team
			}
		}
		if rebuildErr := orgChartSvc.RebuildFromConfig(masterCfg, teams); rebuildErr != nil {
			a.logger.Warn("failed to initial build orgchart", "error", rebuildErr)
		}
	}

	// WebSocket hub
	a.wsHub = ws.NewHub(a.logger)

	// Task dispatcher
	a.dispatcher = orchestrator.NewDispatcher(a.taskStore, a.wsHub, a.logger)

	// Heartbeat monitor
	a.heartbeatMonitor = orchestrator.NewHeartbeatMonitor(a.eventBus, a.logger)
	a.dispatcher.SetHeartbeatMonitor(a.heartbeatMonitor)

	// Container manager (Docker runtime — nil in environments without Docker)
	// The container manager is created with nil runtime when Docker is not available.
	// This allows the binary to run without Docker for development.
	a.containerManager = buildContainerManager(a)

	// SDK tool handler with admin tools
	startTime := time.Now()
	a.toolHandler = orchestrator.NewToolHandler(a.logger)
	a.toolHandler.SetOrgChart(a.orgChart)
	orchestrator.RegisterAdminTools(a.toolHandler, orchestrator.AdminToolsDeps{
		ConfigLoader: a.cfgLoader,
		KeyManager:   a.km,
		WSHub:        a.wsHub,
		StartTime:    startTime,
	})
	orchestrator.RegisterTeamTools(a.toolHandler, orchestrator.TeamToolsDeps{
		ConfigLoader: a.cfgLoader,
		OrgChart:     a.orgChart,
		EventBus:     a.eventBus,
		KeyManager:   a.km,
		Logger:       a.logger,
	})
	orchestrator.RegisterTaskTools(a.toolHandler, orchestrator.TaskToolsDeps{
		TaskStore:        a.taskStore,
		WSHub:            a.wsHub,
		ContainerManager: a.containerManager,
		OrgChart:         a.orgChart,
		Logger:           a.logger,
	})

	// GoOrchestrator
	a.goOrch = orchestrator.NewGoOrchestrator(orchestrator.OrchestratorDeps{
		TaskStore:        a.taskStore,
		WSHub:            a.wsHub,
		ContainerManager: a.containerManager,
		OrgChart:         a.orgChart,
		ConfigLoader:     a.cfgLoader,
		HeartbeatMonitor: a.heartbeatMonitor,
		EventBus:         a.eventBus,
		Dispatcher:       a.dispatcher,
		Logger:           a.logger,
	})

	// Wire dispatcher: tool calls -> toolHandler, task results -> router
	a.dispatcher.SetToolHandler(a.toolHandler)

	// Resolve main assistant's provider config
	assistantProvider, providerExists := providers[masterCfg.Assistant.Provider]
	if !providerExists {
		return fmt.Errorf("assistant references unknown provider: %s", masterCfg.Assistant.Provider)
	}
	mainAgentConfig := ws.AgentInitConfig{
		AID:        masterCfg.Assistant.AID,
		Name:       masterCfg.Assistant.Name,
		RoleFile:   masterCfg.Assistant.RoleFile,
		PromptFile: masterCfg.Assistant.PromptFile,
		Provider:   resolveProviderConfig(assistantProvider),
		ModelTier:  masterCfg.Assistant.ModelTier,
	}

	// Wire up WS message handler
	a.wsHub.SetOnMessage(a.dispatcher.HandleWSMessage)

	// When main container connects, send container_init
	a.wsHub.SetOnConnect(func(teamID string) {
		if teamID == "main" {
			if initErr := a.dispatcher.SendContainerInit(teamID, true, []ws.AgentInitConfig{mainAgentConfig}, nil, masterCfg.System.WorkspaceRoot); initErr != nil {
				a.logger.Error("failed to send container_init", "team_id", teamID, "error", initErr)
			} else {
				a.logger.Info("sent container_init to main container")
			}
		}
	})

	// Message router
	a.router = channel.NewRouter(channel.RouterConfig{
		WSHub:            a.wsHub,
		TaskStore:        a.taskStore,
		SessionStore:     a.sessionStore,
		Logger:           a.logger,
		MainTeamID:       "main",
		MainAssistantAID: masterCfg.Assistant.AID,
	})

	// Wire task results from dispatcher to router for outbound delivery
	a.dispatcher.SetTaskResultCallback(func(ctx context.Context, result *ws.TaskResultMsg) {
		if routeErr := a.router.HandleTaskResult(ctx, result); routeErr != nil {
			a.logger.Error("failed to route task result", "task_id", result.TaskID, "error", routeErr)
		}
	})

	// Decrypt channel tokens for runtime use.
	decryptedChannels, dcErr := cfgLoader.DecryptChannelTokens(masterCfg.Channels)
	if dcErr != nil {
		a.logger.Warn("failed to decrypt channel tokens; channels may not start correctly", "error", dcErr)
		decryptedChannels = masterCfg.Channels
	}

	// Register Discord channel adapter (always create so config-change handler can enable it later).
	a.discordCh = channel.NewDiscordChannel(
		channel.DiscordConfig{
			Token:     decryptedChannels.Discord.Token,
			ChannelID: decryptedChannels.Discord.ChannelID,
			Enabled:   decryptedChannels.Discord.Enabled,
		},
		a.eventBus,
		a.logger,
		nil,
	)
	if regErr := a.router.RegisterChannel(a.discordCh); regErr != nil {
		a.logger.Warn("failed to register Discord channel", "error", regErr)
	} else if decryptedChannels.Discord.Enabled {
		if connErr := a.discordCh.Connect(); connErr != nil {
			a.logger.Warn("failed to connect Discord channel (will retry on next config reload)", "error", connErr)
		} else {
			a.logger.Info("Discord channel connected")
		}
	}
	// Subscribe to config changes to hot-reload the Discord channel.
	a.eventBus.Subscribe(domain.EventTypeConfigChanged, func(evt domain.Event) {
		cfg, ok := evt.Payload.(*domain.MasterConfig)
		if !ok {
			return
		}
		decrypted, dcErr := cfgLoader.DecryptChannelTokens(cfg.Channels)
		if dcErr != nil {
			a.logger.Warn("discord config reload: failed to decrypt channel tokens", "error", dcErr)
			decrypted = cfg.Channels
		}
		a.discordCh.HandleConfigChange(
			decrypted.Discord.Token,
			decrypted.Discord.ChannelID,
			decrypted.Discord.Enabled,
		)
	})

	// Register WhatsApp channel adapter (always create so config-change handler can enable it later).
	a.waCh = channel.NewWhatsAppChannel(
		channel.WhatsAppConfig{
			StorePath: decryptedChannels.WhatsApp.StorePath,
			Enabled:   decryptedChannels.WhatsApp.Enabled,
		},
		a.logger,
		nil,
	)
	if regErr := a.router.RegisterChannel(a.waCh); regErr != nil {
		a.logger.Warn("failed to register WhatsApp channel", "error", regErr)
	} else if decryptedChannels.WhatsApp.Enabled {
		if connErr := a.waCh.Connect(); connErr != nil {
			a.logger.Warn("failed to connect WhatsApp channel (will retry on next config reload)", "error", connErr)
		} else {
			a.logger.Info("WhatsApp channel connected")
		}
	}
	// Subscribe to config changes to hot-reload the WhatsApp channel.
	a.eventBus.Subscribe(domain.EventTypeConfigChanged, func(evt domain.Event) {
		cfg, ok := evt.Payload.(*domain.MasterConfig)
		if !ok {
			return
		}
		decrypted, dcErr := cfgLoader.DecryptChannelTokens(cfg.Channels)
		if dcErr != nil {
			a.logger.Warn("whatsapp config reload: failed to decrypt channel tokens", "error", dcErr)
			decrypted = cfg.Channels
		}
		a.waCh.HandleConfigChange(
			decrypted.WhatsApp.StorePath,
			decrypted.WhatsApp.Enabled,
		)
	})

	// API channel (REST-based synchronous chat endpoint)
	a.apiCh = channel.NewAPIChannel(a.logger)
	if regErr := a.router.RegisterChannel(a.apiCh); regErr != nil {
		return fmt.Errorf("failed to register API channel: %w", regErr)
	}
	if connErr := a.apiCh.Connect(); connErr != nil {
		return fmt.Errorf("failed to connect API channel: %w", connErr)
	}

	listenAddr := os.Getenv("OPENHIVE_SYSTEM_LISTEN_ADDRESS")
	if listenAddr == "" {
		listenAddr = masterCfg.System.ListenAddress
		if listenAddr == "" {
			listenAddr = "127.0.0.1:8080"
		}
	}

	// Portal WebSocket handler for real-time event streaming
	maxPortalConns := masterCfg.System.PortalWSMaxConnections
	if maxPortalConns <= 0 {
		maxPortalConns = 10
	}
	a.portalWS = api.NewPortalWSHandler(a.eventBus, a.logger, maxPortalConns)

	// Log archiver
	a.logArchiver = logging.NewArchiver(a.logStore, masterCfg.System.LogArchive, a.logger)

	// Message archiver (daily cleanup based on MessageArchive config)
	a.msgArchiverStop = make(chan struct{})
	a.msgArchiverDone = make(chan struct{})

	// HTTP server
	a.apiServer = api.NewServerWithDeps(
		listenAddr,
		a.logger,
		a.km,
		a.spaFS,
		a.wsHub.HandleUpgrade,
		a.apiCh.HandleChat,
		nil, // CORS origins — configured from config
		api.ServerDeps{
			LogStore:         a.logStore,
			TaskStore:        a.taskStore,
			ConfigLoader:     a.cfgLoader,
			OrgChart:         a.orgChart,
			GoOrchestrator:   a.goOrch,
			HeartbeatMonitor: a.heartbeatMonitor,
			PortalWS:         a.portalWS,
			DBLogger:         a.dbLogger,
		LogWriter:        a.dbLogger,
		},
	)

	// Generate WS token for the master agent-runner child process
	wsToken, err := a.wsHub.GenerateToken("main")
	if err != nil {
		return fmt.Errorf("failed to generate WS token for child process: %w", err)
	}

	// Child process manager for Node.js orchestrator.
	// In Docker: Go runs as root (PID 1, needs volume + socket access),
	// child drops to UID 1000 (node user) because Claude Code SDK
	// refuses --dangerously-skip-permissions when running as root.
	childCfg := orchestrator.ChildProcessConfig{
		Command: "node",
		Args:    []string{"agent-runner/dist/index.js", "--mode=master"},
		Env: map[string]string{
			"WS_TOKEN": wsToken,
			"WS_URL":   fmt.Sprintf("ws://%s/ws/container?token=%s", listenAddr, wsToken),
		},
	}
	if os.Getuid() == 0 {
		// Running as root (Docker master container) — drop child to node user.
		// HOME must match the target user for Claude SDK to find its config.
		childCfg.UID = 1000
		childCfg.GID = 1000
		childCfg.Env["HOME"] = "/home/node"
	}
	a.childMgr = orchestrator.NewChildProcessManager(childCfg, a.logger)

	return nil
}

// Start starts all background components.
func (a *App) Start(ctx context.Context) error {
	// Start GoOrchestrator (heartbeat monitor + stale reaper)
	if err := a.goOrch.Start(ctx); err != nil {
		a.logger.Warn("failed to start GoOrchestrator", "error", err)
	}

	// Start log archiver
	a.logArchiver.Start()

	// Start message archiver goroutine
	go a.messageArchiverLoop(ctx, a.masterCfg.System.MessageArchive)

	// Start child process
	if childErr := a.childMgr.Start(ctx); childErr != nil {
		a.logger.Warn("failed to start child process (may not be compiled yet)", "error", childErr)
	}

	return nil
}

// Shutdown stops all components in reverse order.
func (a *App) Shutdown() {
	// Stop GoOrchestrator
	if a.goOrch != nil {
		if err := a.goOrch.Stop(); err != nil {
			a.logger.Error("GoOrchestrator stop error", "error", err)
		}
	}

	// Stop child process
	if a.childMgr != nil {
		if err := a.childMgr.Stop(); err != nil {
			a.logger.Error("child process stop error", "error", err)
		}
	}

	// Stop log archiver
	if a.logArchiver != nil {
		a.logArchiver.Stop()
	}

	// Stop message archiver
	if a.msgArchiverStop != nil {
		select {
		case <-a.msgArchiverStop:
		default:
			close(a.msgArchiverStop)
		}
		<-a.msgArchiverDone
	}

	// Disconnect channels
	if a.apiCh != nil {
		_ = a.apiCh.Disconnect()
	}
	if a.discordCh != nil {
		_ = a.discordCh.Disconnect()
	}
	if a.waCh != nil {
		_ = a.waCh.Disconnect()
	}

	// Close event bus
	if a.eventBus != nil {
		a.eventBus.Close()
	}

	// Stop DB logger
	if a.dbLogger != nil {
		a.dbLogger.Stop()
	}

	// Shutdown HTTP server
	if a.apiServer != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if shutdownErr := a.apiServer.Shutdown(shutdownCtx); shutdownErr != nil {
			a.logger.Error("HTTP server shutdown error", "error", shutdownErr)
		}
	}

	a.logger.Info("shutdown complete")
}

// listenAddr returns the configured listen address.
func (a *App) listenAddr() string {
	if a.apiServer != nil {
		return a.apiServer.Addr()
	}
	return ""
}

// messageArchiverLoop runs daily message cleanup based on MessageArchive config.
func (a *App) messageArchiverLoop(ctx context.Context, cfg domain.ArchiveConfig) {
	defer close(a.msgArchiverDone)

	if !cfg.Enabled {
		return
	}

	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			a.archiveMessages(cfg)
		case <-ctx.Done():
			return
		case <-a.msgArchiverStop:
			return
		}
	}
}

// archiveMessages deletes messages older than the retention period.
func (a *App) archiveMessages(cfg domain.ArchiveConfig) {
	retentionDays := 30
	if cfg.MaxEntries > 0 {
		// Reuse MaxEntries as retention days for messages
		retentionDays = cfg.MaxEntries
	}

	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	deleted, err := a.messageStore.DeleteBefore(context.Background(), cutoff)
	if err != nil {
		a.logger.Error("message archiver: failed to delete old messages", "error", err)
		return
	}
	if deleted > 0 {
		a.logger.Info("message archiver: deleted old messages",
			"count", deleted,
			"cutoff", cutoff.Format(time.DateOnly),
		)
	}
}

// applyLogLevel parses a log level string and sets it on the LevelVar.
func applyLogLevel(lv *slog.LevelVar, level string) {
	switch level {
	case "debug":
		lv.Set(slog.LevelDebug)
	case "warn":
		lv.Set(slog.LevelWarn)
	case "error":
		lv.Set(slog.LevelError)
	default:
		lv.Set(slog.LevelInfo)
	}
}

// resolveProviderConfig converts a domain.Provider to ws.ProviderConfig.
func resolveProviderConfig(p domain.Provider) ws.ProviderConfig {
	cfg := ws.ProviderConfig{Type: p.Type}

	pt, _ := domain.ParseProviderType(p.Type)
	switch pt {
	case domain.ProviderTypeOAuth:
		cfg.OAuthToken = p.OAuthToken
	case domain.ProviderTypeAnthropicDirect:
		cfg.APIKey = p.APIKey
		cfg.APIURL = p.BaseURL
	}

	return cfg
}

// buildContainerManager creates the container manager.
// Returns nil when Docker is not available (non-fatal for development).
func buildContainerManager(a *App) domain.ContainerManager {
	imageName := "openhive-team:latest"
	runtime, err := container.NewDockerRuntime(imageName, a.logger)
	if err != nil {
		a.logger.Warn("Docker runtime unavailable, container management disabled", "error", err)
		return nil
	}

	listenAddr := os.Getenv("OPENHIVE_SYSTEM_LISTEN_ADDRESS")
	if listenAddr == "" {
		if a.masterCfg != nil && a.masterCfg.System.ListenAddress != "" {
			listenAddr = a.masterCfg.System.ListenAddress
		} else {
			listenAddr = "127.0.0.1:8080"
		}
	}

	return container.NewManager(container.ManagerConfig{
		Runtime:      runtime,
		WSHub:        a.wsHub,
		ConfigLoader: a.cfgLoader,
		Logger:       a.logger,
		WSURL:        fmt.Sprintf("ws://%s", listenAddr),
	})
}
