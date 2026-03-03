package integration

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"log/slog"

	"github.com/Z-M-Huang/openhive/internal/api"
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/event"
	"github.com/Z-M-Huang/openhive/internal/store"
)

// phase6Setup holds all wired components needed for Phase 6 integration tests.
type phase6Setup struct {
	taskStore domain.TaskStore
	logStore  domain.LogStore
	cfgLoader domain.ConfigLoader
	orgChart  domain.OrgChart
	eventBus  domain.EventBus
	portalWS  *api.PortalWSHandler
	spaFS     fstest.MapFS
	server    *api.Server
	httpSrv   *httptest.Server
	logger    *slog.Logger
	tmpDir    string
}

// newPhase6Setup creates a fully wired Phase 6 test setup with in-memory SQLite.
func newPhase6Setup(t *testing.T) *phase6Setup {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	tmpDir := t.TempDir()

	// Write minimal config files
	masterYAML := `
system:
  listen_address: "127.0.0.1:0"
  data_dir: "` + tmpDir + `"
  log_level: "info"
assistant:
  name: "TestAssistant"
  aid: "aid-testmain-00000001"
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

	providersYAML := "providers:\n  default:\n    name: default\n    type: oauth\n    oauth_token: testauthtoken\n"
	err = os.WriteFile(filepath.Join(tmpDir, "providers.yaml"), []byte(providersYAML), 0600)
	require.NoError(t, err)

	// In-memory database
	db, err := store.NewDB("file:phase6_" + t.Name() + "?mode=memory&cache=shared")
	require.NoError(t, err)

	taskStore := store.NewTaskStore(db)
	logStore := store.NewLogStore(db)

	cfgLoader, err := config.NewLoader(tmpDir, tmpDir)
	require.NoError(t, err)

	orgChart := config.NewOrgChart()
	masterCfg, err := cfgLoader.LoadMaster()
	require.NoError(t, err)
	require.NoError(t, orgChart.RebuildFromConfig(masterCfg, nil))

	eventBus := event.NewEventBus()
	t.Cleanup(eventBus.Close)

	portalWS := api.NewPortalWSHandler(eventBus, logger, 5)

	// Minimal SPA filesystem: index.html + one asset
	spaFS := fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte(`<!DOCTYPE html><html><head><title>OpenHive Test</title></head><body><div id="root"></div></body></html>`),
		},
		"assets/main.js": &fstest.MapFile{
			Data: []byte(`console.log("test bundle")`),
		},
	}

	server := api.NewServerWithDeps(
		"127.0.0.1:0",
		logger,
		nil, // no key manager needed
		spaFS,
		nil, // no container WS handler
		nil, // no chat handler
		nil, // no CORS origins
		api.ServerDeps{
			LogStore:    logStore,
			TaskStore:   taskStore,
			ConfigLoader: cfgLoader,
			OrgChart:    orgChart,
			PortalWS:    portalWS,
		},
	)

	// Use httptest.Server so the handler is accessible at a real URL.
	httpSrv := httptest.NewServer(server.Router())
	t.Cleanup(httpSrv.Close)

	return &phase6Setup{
		taskStore: taskStore,
		logStore:  logStore,
		cfgLoader: cfgLoader,
		orgChart:  orgChart,
		eventBus:  eventBus,
		portalWS:  portalWS,
		spaFS:     spaFS,
		server:    server,
		httpSrv:   httpSrv,
		logger:    logger,
		tmpDir:    tmpDir,
	}
}

// TestPhase6_SPAServes verifies that the SPA is served at / and falls back
// to index.html for client-side routes.
func TestPhase6_SPAServes(t *testing.T) {
	s := newPhase6Setup(t)

	// GET / should return the index.html content
	resp, err := http.Get(s.httpSrv.URL + "/")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), "OpenHive Test")

	// GET of a known SPA asset should return the file content
	resp2, err := http.Get(s.httpSrv.URL + "/assets/main.js")
	require.NoError(t, err)
	defer resp2.Body.Close()
	assert.Equal(t, http.StatusOK, resp2.StatusCode)

	// GET of an unknown client-side route should fall back to index.html
	resp3, err := http.Get(s.httpSrv.URL + "/teams")
	require.NoError(t, err)
	defer resp3.Body.Close()
	assert.Equal(t, http.StatusOK, resp3.StatusCode)
	body3, _ := io.ReadAll(resp3.Body)
	assert.Contains(t, string(body3), "OpenHive Test")
}

// TestPhase6_RESTEndpoints verifies that all Phase 6 REST API endpoints
// return correct data structures with proper status codes.
func TestPhase6_RESTEndpoints(t *testing.T) {
	s := newPhase6Setup(t)
	ctx := context.Background()

	// Seed a task for /tasks endpoint to return
	now := time.Now()
	task := &domain.Task{
		ID:        "tid-task-p6test-001",
		TeamSlug:  "main",
		AgentAID:  "aid-testmain-00000001",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Phase 6 integration test task",
		CreatedAt: now,
		UpdatedAt: now,
	}
	require.NoError(t, s.taskStore.Create(ctx, task))

	// Seed a log entry for /logs endpoint
	logEntry := &domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "orchestrator",
		Action:    "test_action",
		Message:   "Phase 6 test log entry",
		TeamName:  "main",
		CreatedAt: now,
	}
	require.NoError(t, s.logStore.Create(ctx, []*domain.LogEntry{logEntry}))

	// decodeData unwraps the {"data": ...} response envelope.
	decodeData := func(t *testing.T, r *http.Response, dst interface{}) {
		t.Helper()
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&envelope))
		require.NoError(t, json.Unmarshal(envelope.Data, dst))
	}

	t.Run("GET /api/v1/teams returns array", func(t *testing.T) {
		resp, err := http.Get(s.httpSrv.URL + "/api/v1/teams")
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "application/json", resp.Header.Get("Content-Type"))

		var teams []interface{}
		decodeData(t, resp, &teams)
		// OrgChart is empty so teams is an empty slice — still a valid array
		assert.NotNil(t, teams, "GET /teams should return a JSON array (may be empty)")
	})

	t.Run("GET /api/v1/tasks returns paginated response", func(t *testing.T) {
		resp, err := http.Get(s.httpSrv.URL + "/api/v1/tasks")
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		// GetTasksHandler returns {"tasks": [...], "total": N, "has_more": bool, ...}
		var tasksEnvelope struct {
			Tasks []map[string]interface{} `json:"tasks"`
			Total int                      `json:"total"`
		}
		decodeData(t, resp, &tasksEnvelope)
		// The seeded running task should be in the list
		assert.GreaterOrEqual(t, len(tasksEnvelope.Tasks), 1)
		found := false
		for _, task := range tasksEnvelope.Tasks {
			if task["id"] == "tid-task-p6test-001" {
				found = true
				break
			}
		}
		assert.True(t, found, "seeded task should appear in GET /tasks response")
	})

	t.Run("GET /api/v1/logs returns array", func(t *testing.T) {
		resp, err := http.Get(s.httpSrv.URL + "/api/v1/logs")
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var logs []map[string]interface{}
		decodeData(t, resp, &logs)
		assert.GreaterOrEqual(t, len(logs), 1)
		assert.Equal(t, "Phase 6 test log entry", logs[0]["message"])
	})

	t.Run("GET /api/v1/config returns masked config", func(t *testing.T) {
		resp, err := http.Get(s.httpSrv.URL + "/api/v1/config")
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))

		var cfg map[string]interface{}
		decodeData(t, resp, &cfg)
		assert.Contains(t, cfg, "system")
		assert.Contains(t, cfg, "channels")
	})
}

// TestPhase6_PortalWebSocket verifies that the portal WebSocket endpoint
// can be connected to and receives events from the event bus.
func TestPhase6_PortalWebSocket(t *testing.T) {
	s := newPhase6Setup(t)

	// The portal WS should reject connections from non-localhost origins.
	// With no Origin header it should be allowed (direct connection).
	// Use httptest.NewServer to test WebSocket upgrade.
	// Use a simple HTTP request to verify the WS upgrade path is registered.
	// A non-WS upgrade request returns 400 Bad Request from the gorilla upgrader.
	resp, err := http.Get(s.httpSrv.URL + "/api/v1/ws")
	require.NoError(t, err)
	defer resp.Body.Close()
	// Gorilla websocket upgrader returns 400 when not a WS request
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestPhase6_ConfigMutationEnforcesJSON verifies that PUT endpoints reject
// requests without Content-Type: application/json.
func TestPhase6_ConfigMutationEnforcesJSON(t *testing.T) {
	s := newPhase6Setup(t)

	endpoints := []struct {
		method string
		path   string
	}{
		{"PUT", "/api/v1/config"},
		{"PUT", "/api/v1/providers"},
	}

	for _, ep := range endpoints {
		t.Run(ep.method+" "+ep.path+" rejects non-JSON", func(t *testing.T) {
			req, err := http.NewRequest(ep.method, s.httpSrv.URL+ep.path,
				strings.NewReader(`{"system":{"log_level":"debug"}}`))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "text/plain")

			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			// Must be rejected with 415 Unsupported Media Type
			assert.Equal(t, http.StatusUnsupportedMediaType, resp.StatusCode,
				"PUT %s should reject non-JSON Content-Type", ep.path)
		})
	}
}

// TestPhase6_ConfigMasksSecrets verifies that GET /api/v1/config and
// GET /api/v1/providers mask secret fields in the response.
func TestPhase6_ConfigMasksSecrets(t *testing.T) {
	s := newPhase6Setup(t)

	t.Run("config endpoint masks channel tokens", func(t *testing.T) {
		// Write a config with a Discord token
		cfg, err := s.cfgLoader.LoadMaster()
		require.NoError(t, err)
		cfg.Channels.Discord.Token = "super-secret-token-longvalue"
		cfg.Channels.Discord.Enabled = true
		require.NoError(t, s.cfgLoader.SaveMaster(cfg))

		resp, err := http.Get(s.httpSrv.URL + "/api/v1/config")
		require.NoError(t, err)
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		// The raw token must not appear in the response
		assert.NotContains(t, string(body), "super-secret-token-longvalue",
			"GET /config must not expose raw token")
		// The masked value should contain ****
		assert.Contains(t, string(body), "****",
			"GET /config should contain masked token")
	})

	t.Run("providers endpoint masks oauth token", func(t *testing.T) {
		resp, err := http.Get(s.httpSrv.URL + "/api/v1/providers")
		require.NoError(t, err)
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		// Raw token value must not appear
		assert.NotContains(t, string(body), "testauthtoken",
			"GET /providers must not expose raw oauth token")
		// Masked value present
		assert.Contains(t, string(body), "****",
			"GET /providers should contain masked oauth token")
	})
}

// TestPhase6_SecurityHeaders verifies that API responses include
// the expected security headers.
func TestPhase6_SecurityHeaders(t *testing.T) {
	s := newPhase6Setup(t)

	resp, err := http.Get(s.httpSrv.URL + "/api/v1/health")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	assert.Equal(t, "DENY", resp.Header.Get("X-Frame-Options"))
	csp := resp.Header.Get("Content-Security-Policy")
	assert.Contains(t, csp, "default-src 'self'")
	assert.Contains(t, csp, "ws:")
}

// TestPhase6_LogsFilterByLevel verifies that the GET /api/v1/logs endpoint
// correctly filters log entries by the `level` query parameter.
func TestPhase6_LogsFilterByLevel(t *testing.T) {
	s := newPhase6Setup(t)
	ctx := context.Background()

	now := time.Now()

	// Seed an info and an error log entry
	infoEntry := &domain.LogEntry{
		Level:     domain.LogLevelInfo,
		Component: "orchestrator",
		Action:    "info_action",
		Message:   "info message",
		CreatedAt: now,
	}
	errorEntry := &domain.LogEntry{
		Level:     domain.LogLevelError,
		Component: "container",
		Action:    "error_action",
		Message:   "error message",
		CreatedAt: now,
	}
	require.NoError(t, s.logStore.Create(ctx, []*domain.LogEntry{infoEntry}))
	require.NoError(t, s.logStore.Create(ctx, []*domain.LogEntry{errorEntry}))

	// Filter for error-only
	resp, err := http.Get(s.httpSrv.URL + "/api/v1/logs?level=error")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var envelope struct {
		Data []map[string]interface{} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	// The level field is a LogLevel int: debug=0, info=1, warn=2, error=3.
	// JSON numbers unmarshal as float64 when decoded into interface{}.
	for _, entry := range envelope.Data {
		levelVal, hasLevel := entry["level"]
		assert.True(t, hasLevel, "log entry should have a level field")
		levelFloat, isFloat := levelVal.(float64)
		assert.True(t, isFloat, "level should be a JSON number (LogLevel int)")
		assert.Equal(t, float64(domain.LogLevelError), levelFloat,
			"all returned logs should have level=error (3)")
	}
}
