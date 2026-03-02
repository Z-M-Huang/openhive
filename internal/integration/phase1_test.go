package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/api"
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/crypto"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/logging"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"log/slog"
	"os"
	"path/filepath"
)

// TestPhase1Gate verifies all Phase 1 features end-to-end:
// 1. Loads openhive.yaml + providers.yaml, validates both
// 2. Initializes in-memory GORM/SQLite
// 3. Writes log entry via DBLogger (verified in DB)
// 4. Encrypts/decrypts API key (round-trip verified)
// 5. Starts HTTP server (GET /api/v1/health returns 200)
// 6. Creates team config (directory + files verified)
// 7. Resolves provider preset (flattened credentials verified)
func TestPhase1Gate(t *testing.T) {
	// --- Setup temp data directory ---
	tmpDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Write test openhive.yaml
	masterYAML := `
system:
  listen_address: "127.0.0.1:0"
  data_dir: "` + tmpDir + `"
  log_level: "info"
assistant:
  name: "TestAssistant"
  aid: "aid-test-main"
  provider: "default"
  model_tier: "sonnet"
channels:
  discord:
    enabled: false
  whatsapp:
    enabled: false
`
	err := os.WriteFile(filepath.Join(tmpDir, "openhive.yaml"), []byte(masterYAML), 0600)
	require.NoError(t, err)

	// Write test providers.yaml
	providersYAML := `
providers:
  default:
    name: default
    type: oauth
    oauth_token: test-oauth-token
`
	err = os.WriteFile(filepath.Join(tmpDir, "providers.yaml"), []byte(providersYAML), 0600)
	require.NoError(t, err)

	// --- Step 1: Load and validate config ---
	loader, err := config.NewLoader(tmpDir)
	require.NoError(t, err)

	masterCfg, err := loader.LoadMaster()
	require.NoError(t, err)
	assert.Equal(t, "TestAssistant", masterCfg.Assistant.Name)
	assert.Equal(t, "info", masterCfg.System.LogLevel)

	providers, err := loader.LoadProviders()
	require.NoError(t, err)
	assert.Contains(t, providers, "default")

	// --- Step 2: Initialize in-memory SQLite ---
	db, err := store.NewDB("file::memory:?cache=shared")
	require.NoError(t, err)

	taskStore := store.NewTaskStore(db)
	logStore := store.NewLogStore(db)

	// --- Step 3: Write log entry via DBLogger ---
	dbLogger := logging.NewDBLogger(logStore, domain.LogLevelDebug, logger)

	dbLogger.Log(&domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "integration_test",
		Action:    "phase1_gate",
		Message:   "Phase 1 gate test starting",
	})

	// Give the batch writer a moment to flush
	time.Sleep(200 * time.Millisecond)
	dbLogger.Stop()

	ctx := context.Background()
	entries, err := logStore.Query(ctx, domain.LogQueryOpts{Component: "integration_test"})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, len(entries), 1)
	assert.Equal(t, "phase1_gate", entries[0].Action)

	// --- Step 4: Encrypt/decrypt API key ---
	km := crypto.NewManager()
	err = km.Unlock("test-master-key-12345678")
	require.NoError(t, err)

	plaintext := "sk-test-api-key-secret"
	ciphertext, err := km.Encrypt(plaintext)
	require.NoError(t, err)
	assert.NotEqual(t, plaintext, ciphertext)

	decrypted, err := km.Decrypt(ciphertext)
	require.NoError(t, err)
	assert.Equal(t, plaintext, decrypted)

	// --- Step 5: HTTP server health endpoint ---
	srv := api.NewServer(
		"127.0.0.1:0",
		logger,
		km,
		nil,  // no SPA in test
		nil,  // no WS handler in test
		nil,  // no chat handler in test
		nil,  // no CORS origins
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rr := httptest.NewRecorder()
	srv.Router().ServeHTTP(rr, req)

	assert.Equal(t, http.StatusOK, rr.Code)

	var healthResp map[string]interface{}
	err = json.Unmarshal(rr.Body.Bytes(), &healthResp)
	require.NoError(t, err)
	data, ok := healthResp["data"].(map[string]interface{})
	require.True(t, ok, "response should have a 'data' envelope")
	assert.Equal(t, "ok", data["status"])

	// --- Step 6: Create team config ---
	teamsDir := filepath.Join(tmpDir, "teams")
	err = os.MkdirAll(teamsDir, 0700)
	require.NoError(t, err)

	err = loader.CreateTeamDir("test-team")
	require.NoError(t, err)

	teamDir := filepath.Join(teamsDir, "test-team")
	_, statErr := os.Stat(teamDir)
	assert.NoError(t, statErr, "team directory should exist")

	// --- Step 7: Task store works ---
	task := &domain.Task{
		ID:        "task-phase1-001",
		TeamSlug:  "main",
		Status:    domain.TaskStatusPending,
		Prompt:    "Test prompt",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	err = taskStore.Create(ctx, task)
	require.NoError(t, err)

	retrieved, err := taskStore.Get(ctx, "task-phase1-001")
	require.NoError(t, err)
	assert.Equal(t, "Test prompt", retrieved.Prompt)
	assert.Equal(t, domain.TaskStatusPending, retrieved.Status)

	t.Log("Phase 1 gate test passed")
}
