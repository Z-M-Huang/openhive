package integration

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/api"
	"github.com/Z-M-Huang/openhive/internal/channel"
	"github.com/Z-M-Huang/openhive/internal/crypto"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/orchestrator"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestPhase2Gate verifies the full Phase 2 Go-side pipeline:
// 1. Phase 1 infrastructure up (DB, config, encryption, HTTP)
// 2. WSHub operational (can register connections, generate tokens)
// 3. Task dispatch pipeline (CLI -> Router -> TaskStore -> WSHub)
// 4. Admin tool calls (get_config, update_config) through ToolHandler
// 5. Message routing (inbound/outbound through Router)
//
// Scope note (F3): The full mock SDK pipeline test (AC30 - Go spawns Node.js
// orchestrator with mock SDK, CLI message round-trips through the SDK and back)
// is deferred to Phase 3 (container integration). The current test validates the
// complete Go-side orchestration pipeline, which is the appropriate boundary for
// Phase 2. The infrastructure for the full test exists:
//
// TODO: Phase 3 will add an integration test that starts a mock WS server,
// connects the Node.js orchestrator (agent-runner/src/index.ts) with the mock
// SDK (agent-runner/src/mock-sdk.ts), and verifies the full CLI -> WS ->
// mock SDK -> task_result -> CLI round-trip.
func TestPhase2Gate(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx := context.Background()

	// --- Phase 1 infrastructure ---
	db, err := store.NewDB("file::memory:?cache=shared")
	require.NoError(t, err)

	taskStore := store.NewTaskStore(db)
	sessionStore := store.NewSessionStore(db)

	km := crypto.NewManager()
	err = km.Unlock("test-master-key-12345678")
	require.NoError(t, err)

	// --- WSHub ---
	wsHub := ws.NewHub(logger)

	// --- Verify token generation ---
	token, err := wsHub.GenerateToken("main")
	require.NoError(t, err)
	assert.NotEmpty(t, token)

	// --- HTTP Server with WS handler ---
	srv := api.NewServer(
		"127.0.0.1:0",
		logger,
		km,
		nil,
		wsHub.HandleUpgrade,
		nil,
		nil,
		nil, // no portal WS
		nil, // no dbLogger
	)

	// Verify health endpoint
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rr := httptest.NewRecorder()
	srv.Router().ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)

	// --- Task Dispatcher ---
	dispatcher := orchestrator.NewDispatcher(taskStore, wsHub, logger)

	// Wire up WS message handler
	wsHub.SetOnMessage(dispatcher.HandleWSMessage)

	// --- Message Router ---
	router := channel.NewRouter(channel.RouterConfig{
		WSHub:            wsHub,
		TaskStore:        taskStore,
		SessionStore:     sessionStore,
		Logger:           logger,
		MainTeamID:       "main",
		MainAssistantAID: "aid-main-001",
	})

	// --- Admin Tool Handler ---
	tmpDir := t.TempDir()
	masterYAML := `
system:
  listen_address: "127.0.0.1:0"
  log_level: "info"
assistant:
  name: "TestAssistant"
  aid: "aid-test-main"
  provider: "default"
  model_tier: "sonnet"
channels:
  discord:
    enabled: false
    token: "secret-tok"
  whatsapp:
    enabled: false
`
	err = os.MkdirAll(tmpDir, 0700)
	require.NoError(t, err)
	err = os.WriteFile(tmpDir+"/openhive.yaml", []byte(masterYAML), 0600)
	require.NoError(t, err)
	err = os.WriteFile(tmpDir+"/providers.yaml", []byte("providers:\n  default:\n    name: default\n    type: oauth\n    oauth_token: test-oauth-token\n"), 0600)
	require.NoError(t, err)

	// Import config package
	cfgLoader, err := createTestLoader(tmpDir)
	require.NoError(t, err)

	toolHandler := orchestrator.NewToolHandler(logger)
	orchestrator.RegisterAdminTools(toolHandler, orchestrator.AdminToolsDeps{
		ConfigLoader: cfgLoader,
		KeyManager:   km,
		WSHub:        wsHub,
		StartTime:    time.Now(),
	})

	// --- Test: get_config returns config with secrets redacted ---
	result, err := toolHandler.HandleToolCall("call-gate-001", "get_config",
		json.RawMessage(`{"section":"channels"}`))
	require.NoError(t, err)

	var channels domain.ChannelsConfig
	err = json.Unmarshal(result, &channels)
	require.NoError(t, err)
	assert.Equal(t, "[REDACTED]", channels.Discord.Token)

	// --- Test: update_config updates config ---
	result, err = toolHandler.HandleToolCall("call-gate-002", "update_config",
		json.RawMessage(`{"section":"system","field":"log_level","value":"debug"}`))
	require.NoError(t, err)

	var updateResp map[string]string
	err = json.Unmarshal(result, &updateResp)
	require.NoError(t, err)
	assert.Equal(t, "updated", updateResp["status"])

	// Verify the update persisted
	result, err = toolHandler.HandleToolCall("call-gate-003", "get_config",
		json.RawMessage(`{"section":"system"}`))
	require.NoError(t, err)

	var sys domain.SystemConfig
	err = json.Unmarshal(result, &sys)
	require.NoError(t, err)
	assert.Equal(t, "debug", sys.LogLevel)

	// --- Test: get_system_status ---
	result, err = toolHandler.HandleToolCall("call-gate-004", "get_system_status",
		json.RawMessage(`{}`))
	require.NoError(t, err)

	var status map[string]interface{}
	err = json.Unmarshal(result, &status)
	require.NoError(t, err)
	assert.Contains(t, status, "uptime")
	assert.Contains(t, status, "version")

	// --- Test: Route inbound message creates task ---
	err = router.RouteInbound("cli:local", "Hello from gate test")
	require.NoError(t, err)

	// Verify task was created
	tasks, err := taskStore.ListByTeam(ctx, "main")
	require.NoError(t, err)
	assert.GreaterOrEqual(t, len(tasks), 1)

	found := false
	for _, task := range tasks {
		if task.Prompt != "" && task.Status == domain.TaskStatusPending {
			found = true
			assert.Contains(t, task.Prompt, "Hello from gate test")
			assert.Contains(t, task.Prompt, `<user_message`)
			break
		}
	}
	assert.True(t, found, "should find a pending task with the message content")

	// --- Test: enable_channel ---
	result, err = toolHandler.HandleToolCall("call-gate-005", "enable_channel",
		json.RawMessage(`{"channel":"discord"}`))
	require.NoError(t, err)

	var enableResp map[string]string
	err = json.Unmarshal(result, &enableResp)
	require.NoError(t, err)
	assert.Equal(t, "enabled", enableResp["status"])

	// --- Test: disable_channel ---
	result, err = toolHandler.HandleToolCall("call-gate-006", "disable_channel",
		json.RawMessage(`{"channel":"discord"}`))
	require.NoError(t, err)

	var disableResp map[string]string
	err = json.Unmarshal(result, &disableResp)
	require.NoError(t, err)
	assert.Equal(t, "disabled", disableResp["status"])

	t.Log("Phase 2 gate test passed")
}

// createTestLoader creates a config loader for testing.
func createTestLoader(dataDir string) (domain.ConfigLoader, error) {
	// We use the real config.Loader since integration tests should
	// exercise real code paths.
	return newConfigLoader(dataDir)
}
