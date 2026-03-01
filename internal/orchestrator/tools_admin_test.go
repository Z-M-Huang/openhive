package orchestrator

import (
	"encoding/json"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockConfigLoader "github.com/Z-M-Huang/openhive/internal/mocks/ConfigLoader"
	mockKeyManager "github.com/Z-M-Huang/openhive/internal/mocks/KeyManager"
	mockWSHub "github.com/Z-M-Huang/openhive/internal/mocks/WSHub"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func newAdminToolHandler(t *testing.T) (*ToolHandler, *mockConfigLoader.MockConfigLoader, *mockWSHub.MockWSHub) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	handler := NewToolHandler(logger)

	cl := mockConfigLoader.NewMockConfigLoader(t)
	km := mockKeyManager.NewMockKeyManager(t)
	hub := mockWSHub.NewMockWSHub(t)

	deps := AdminToolsDeps{
		ConfigLoader: cl,
		KeyManager:   km,
		WSHub:        hub,
		StartTime:    time.Now().Add(-5 * time.Minute),
	}

	RegisterAdminTools(handler, deps)

	return handler, cl, hub
}

func testMasterConfig() *domain.MasterConfig {
	return &domain.MasterConfig{
		System: domain.SystemConfig{
			ListenAddress: "127.0.0.1:8080",
			LogLevel:      "info",
		},
		Assistant: domain.AssistantConfig{
			Name:      "Assistant",
			AID:       "aid-main",
			Provider:  "default",
			ModelTier: "sonnet",
		},
		Channels: domain.ChannelsConfig{
			Discord: domain.ChannelConfig{
				Enabled: false,
				Token:   "secret-discord-token",
			},
			WhatsApp: domain.ChannelConfig{
				Enabled: false,
				Token:   "secret-whatsapp-token",
			},
		},
	}
}

func TestGetConfig_Channels_RedactsSecrets(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	result, err := h.HandleToolCall("call-001", "get_config", json.RawMessage(`{"section":"channels"}`))
	require.NoError(t, err)

	var channels domain.ChannelsConfig
	err = json.Unmarshal(result, &channels)
	require.NoError(t, err)

	assert.Equal(t, "[REDACTED]", channels.Discord.Token)
	assert.Equal(t, "[REDACTED]", channels.WhatsApp.Token)
}

func TestGetConfig_System(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	result, err := h.HandleToolCall("call-002", "get_config", json.RawMessage(`{"section":"system"}`))
	require.NoError(t, err)

	var sys domain.SystemConfig
	err = json.Unmarshal(result, &sys)
	require.NoError(t, err)

	assert.Equal(t, "127.0.0.1:8080", sys.ListenAddress)
	assert.Equal(t, "info", sys.LogLevel)
}

func TestGetConfig_UnknownSection(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	_, err := h.HandleToolCall("call-003", "get_config", json.RawMessage(`{"section":"unknown"}`))
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestGetConfig_AllSections(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	result, err := h.HandleToolCall("call-004", "get_config", json.RawMessage(`{}`))
	require.NoError(t, err)

	var cfg domain.MasterConfig
	err = json.Unmarshal(result, &cfg)
	require.NoError(t, err)

	// Tokens should be redacted
	assert.Equal(t, "[REDACTED]", cfg.Channels.Discord.Token)
}

func TestUpdateConfig_SystemLogLevel(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)
	cl.EXPECT().SaveMaster(mock.MatchedBy(func(cfg *domain.MasterConfig) bool {
		return cfg.System.LogLevel == "debug"
	})).Return(nil)

	result, err := h.HandleToolCall("call-005", "update_config",
		json.RawMessage(`{"section":"system","field":"log_level","value":"debug"}`))
	require.NoError(t, err)

	var data map[string]string
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Equal(t, "updated", data["status"])
}

func TestUpdateConfig_ChannelDiscordEnabled(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)
	cl.EXPECT().SaveMaster(mock.MatchedBy(func(cfg *domain.MasterConfig) bool {
		return cfg.Channels.Discord.Enabled == true
	})).Return(nil)

	result, err := h.HandleToolCall("call-006", "update_config",
		json.RawMessage(`{"section":"channels","field":"discord.enabled","value":true}`))
	require.NoError(t, err)

	var data map[string]string
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Equal(t, "updated", data["status"])
}

func TestUpdateConfig_MissingFields(t *testing.T) {
	h, _, _ := newAdminToolHandler(t)

	_, err := h.HandleToolCall("call-007", "update_config",
		json.RawMessage(`{"section":"","field":""}`))
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestUpdateConfig_InvalidSection(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	_, err := h.HandleToolCall("call-008", "update_config",
		json.RawMessage(`{"section":"invalid","field":"foo","value":"bar"}`))
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestGetSystemStatus(t *testing.T) {
	h, _, hub := newAdminToolHandler(t)

	hub.EXPECT().GetConnectedTeams().Return([]string{"main", "team-a"})

	result, err := h.HandleToolCall("call-009", "get_system_status", json.RawMessage(`{}`))
	require.NoError(t, err)

	var status systemStatusResult
	err = json.Unmarshal(result, &status)
	require.NoError(t, err)

	assert.Len(t, status.ConnectedTeams, 2)
	assert.Contains(t, status.ConnectedTeams, "main")
	assert.Equal(t, "0.1.0", status.Version)
	assert.NotEmpty(t, status.Uptime)
}

func TestListChannels(t *testing.T) {
	h, _, hub := newAdminToolHandler(t)

	hub.EXPECT().GetConnectedTeams().Return([]string{"main"})

	result, err := h.HandleToolCall("call-010", "list_channels", json.RawMessage(`{}`))
	require.NoError(t, err)

	var data map[string]interface{}
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Contains(t, data, "connected_teams")
}

func TestEnableChannel_Discord(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)
	cl.EXPECT().SaveMaster(mock.MatchedBy(func(cfg *domain.MasterConfig) bool {
		return cfg.Channels.Discord.Enabled == true
	})).Return(nil)

	result, err := h.HandleToolCall("call-011", "enable_channel",
		json.RawMessage(`{"channel":"discord"}`))
	require.NoError(t, err)

	var data map[string]string
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Equal(t, "enabled", data["status"])
	assert.Equal(t, "discord", data["channel"])
}

func TestDisableChannel_WhatsApp(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cfg := testMasterConfig()
	cfg.Channels.WhatsApp.Enabled = true
	cl.EXPECT().LoadMaster().Return(cfg, nil)
	cl.EXPECT().SaveMaster(mock.MatchedBy(func(cfg *domain.MasterConfig) bool {
		return cfg.Channels.WhatsApp.Enabled == false
	})).Return(nil)

	result, err := h.HandleToolCall("call-012", "disable_channel",
		json.RawMessage(`{"channel":"whatsapp"}`))
	require.NoError(t, err)

	var data map[string]string
	err = json.Unmarshal(result, &data)
	require.NoError(t, err)
	assert.Equal(t, "disabled", data["status"])
}

func TestEnableChannel_UnknownChannel(t *testing.T) {
	h, cl, _ := newAdminToolHandler(t)

	cl.EXPECT().LoadMaster().Return(testMasterConfig(), nil)

	_, err := h.HandleToolCall("call-013", "enable_channel",
		json.RawMessage(`{"channel":"telegram"}`))
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestEnableChannel_MissingChannelName(t *testing.T) {
	h, _, _ := newAdminToolHandler(t)

	_, err := h.HandleToolCall("call-014", "enable_channel",
		json.RawMessage(`{}`))
	assert.Error(t, err)
	var validErr *domain.ValidationError
	assert.ErrorAs(t, err, &validErr)
}

func TestUnknownTool(t *testing.T) {
	h, _, _ := newAdminToolHandler(t)

	_, err := h.HandleToolCall("call-015", "nonexistent_tool", json.RawMessage(`{}`))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown tool")
}

func TestAllAdminToolsRegistered(t *testing.T) {
	h, _, _ := newAdminToolHandler(t)

	tools := h.RegisteredTools()
	assert.Contains(t, tools, "get_config")
	assert.Contains(t, tools, "update_config")
	assert.Contains(t, tools, "get_system_status")
	assert.Contains(t, tools, "list_channels")
	assert.Contains(t, tools, "enable_channel")
	assert.Contains(t, tools, "disable_channel")
	assert.Len(t, tools, 6)
}
