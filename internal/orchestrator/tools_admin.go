package orchestrator

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// AdminToolsDeps holds dependencies for admin tool handlers.
type AdminToolsDeps struct {
	ConfigLoader domain.ConfigLoader
	KeyManager   domain.KeyManager
	WSHub        domain.WSHub
	StartTime    time.Time
}

// RegisterAdminTools registers all admin SDK custom tool handlers on the ToolHandler.
func RegisterAdminTools(handler *ToolHandler, deps AdminToolsDeps) {
	handler.Register("get_config", makeGetConfig(deps.ConfigLoader))
	handler.Register("update_config", makeUpdateConfig(deps.ConfigLoader))
	handler.Register("get_system_status", makeGetSystemStatus(deps))
	handler.Register("list_channels", makeListChannels(deps.WSHub))
	handler.Register("enable_channel", makeEnableChannel(deps.ConfigLoader))
	handler.Register("disable_channel", makeDisableChannel(deps.ConfigLoader))
}

// getConfigArgs holds arguments for get_config tool.
type getConfigArgs struct {
	Section string `json:"section"`
}

func makeGetConfig(configLoader domain.ConfigLoader) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a getConfigArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		cfg, err := configLoader.LoadMaster()
		if err != nil {
			return nil, fmt.Errorf("failed to load config: %w", err)
		}

		var section interface{}
		switch a.Section {
		case "system":
			section = cfg.System
		case "assistant":
			section = cfg.Assistant
		case "channels":
			// Redact sensitive fields
			redacted := cfg.Channels
			if redacted.Discord.Token != "" {
				redacted.Discord.Token = "[REDACTED]"
			}
			if redacted.WhatsApp.Token != "" {
				redacted.WhatsApp.Token = "[REDACTED]"
			}
			section = redacted
		case "":
			// Return entire config with redaction
			cfgCopy := *cfg
			if cfgCopy.Channels.Discord.Token != "" {
				cfgCopy.Channels.Discord.Token = "[REDACTED]"
			}
			if cfgCopy.Channels.WhatsApp.Token != "" {
				cfgCopy.Channels.WhatsApp.Token = "[REDACTED]"
			}
			section = cfgCopy
		default:
			return nil, &domain.ValidationError{Field: "section", Message: fmt.Sprintf("unknown section: %s", a.Section)}
		}

		return json.Marshal(section)
	}
}

// updateConfigArgs holds arguments for update_config tool.
type updateConfigArgs struct {
	Section string      `json:"section"`
	Field   string      `json:"field"`
	Value   interface{} `json:"value"`
}

func makeUpdateConfig(configLoader domain.ConfigLoader) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a updateConfigArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.Section == "" || a.Field == "" {
			return nil, &domain.ValidationError{Field: "section/field", Message: "section and field are required"}
		}

		cfg, err := configLoader.LoadMaster()
		if err != nil {
			return nil, fmt.Errorf("failed to load config: %w", err)
		}

		// Apply update based on section and field
		switch a.Section {
		case "system":
			if err := applySystemUpdate(cfg, a.Field, a.Value); err != nil {
				return nil, err
			}
		case "channels":
			if err := applyChannelUpdate(cfg, a.Field, a.Value); err != nil {
				return nil, err
			}
		default:
			return nil, &domain.ValidationError{
				Field:   "section",
				Message: fmt.Sprintf("unsupported section for update: %s", a.Section),
			}
		}

		// Save config (will trigger fsnotify/hot-reload)
		if err := configLoader.SaveMaster(cfg); err != nil {
			return nil, fmt.Errorf("failed to save config: %w", err)
		}

		return json.Marshal(map[string]string{"status": "updated"})
	}
}

func applySystemUpdate(cfg *domain.MasterConfig, field string, value interface{}) error {
	switch field {
	case "log_level":
		v, ok := value.(string)
		if !ok {
			return &domain.ValidationError{Field: "value", Message: "log_level must be a string"}
		}
		cfg.System.LogLevel = v
	case "listen_address":
		v, ok := value.(string)
		if !ok {
			return &domain.ValidationError{Field: "value", Message: "listen_address must be a string"}
		}
		cfg.System.ListenAddress = v
	default:
		return &domain.ValidationError{
			Field:   "field",
			Message: fmt.Sprintf("unsupported system field: %s", field),
		}
	}
	return nil
}

func applyChannelUpdate(cfg *domain.MasterConfig, field string, value interface{}) error {
	switch field {
	case "discord.enabled":
		v, ok := value.(bool)
		if !ok {
			return &domain.ValidationError{Field: "value", Message: "discord.enabled must be a boolean"}
		}
		cfg.Channels.Discord.Enabled = v
	case "whatsapp.enabled":
		v, ok := value.(bool)
		if !ok {
			return &domain.ValidationError{Field: "value", Message: "whatsapp.enabled must be a boolean"}
		}
		cfg.Channels.WhatsApp.Enabled = v
	default:
		return &domain.ValidationError{
			Field:   "field",
			Message: fmt.Sprintf("unsupported channel field: %s", field),
		}
	}
	return nil
}

// systemStatusResult holds the result of get_system_status tool.
type systemStatusResult struct {
	ConnectedTeams []string `json:"connected_teams"`
	Uptime         string   `json:"uptime"`
	Version        string   `json:"version"`
}

func makeGetSystemStatus(deps AdminToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		teams := deps.WSHub.GetConnectedTeams()
		uptime := time.Since(deps.StartTime).Round(time.Second)

		result := systemStatusResult{
			ConnectedTeams: teams,
			Uptime:         uptime.String(),
			Version:        "0.1.0",
		}

		return json.Marshal(result)
	}
}

func makeListChannels(wsHub domain.WSHub) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		teams := wsHub.GetConnectedTeams()
		return json.Marshal(map[string]interface{}{
			"connected_teams": teams,
		})
	}
}

// enableChannelArgs holds arguments for enable_channel tool.
type enableChannelArgs struct {
	Channel string `json:"channel"`
}

func makeEnableChannel(configLoader domain.ConfigLoader) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a enableChannelArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.Channel == "" {
			return nil, &domain.ValidationError{Field: "channel", Message: "channel name is required"}
		}

		cfg, err := configLoader.LoadMaster()
		if err != nil {
			return nil, fmt.Errorf("failed to load config: %w", err)
		}

		switch a.Channel {
		case "discord":
			cfg.Channels.Discord.Enabled = true
		case "whatsapp":
			cfg.Channels.WhatsApp.Enabled = true
		default:
			return nil, &domain.ValidationError{
				Field:   "channel",
				Message: fmt.Sprintf("unknown channel: %s", a.Channel),
			}
		}

		if err := configLoader.SaveMaster(cfg); err != nil {
			return nil, fmt.Errorf("failed to save config: %w", err)
		}

		return json.Marshal(map[string]string{"status": "enabled", "channel": a.Channel})
	}
}

func makeDisableChannel(configLoader domain.ConfigLoader) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a enableChannelArgs // same args
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.Channel == "" {
			return nil, &domain.ValidationError{Field: "channel", Message: "channel name is required"}
		}

		cfg, err := configLoader.LoadMaster()
		if err != nil {
			return nil, fmt.Errorf("failed to load config: %w", err)
		}

		switch a.Channel {
		case "discord":
			cfg.Channels.Discord.Enabled = false
		case "whatsapp":
			cfg.Channels.WhatsApp.Enabled = false
		default:
			return nil, &domain.ValidationError{
				Field:   "channel",
				Message: fmt.Sprintf("unknown channel: %s", a.Channel),
			}
		}

		if err := configLoader.SaveMaster(cfg); err != nil {
			return nil, fmt.Errorf("failed to save config: %w", err)
		}

		return json.Marshal(map[string]string{"status": "disabled", "channel": a.Channel})
	}
}
