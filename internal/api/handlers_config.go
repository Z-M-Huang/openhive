package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// maskSecret replaces a secret string with masked representation.
// Returns '****' + last 4 characters if len > 4, else '****'.
func maskSecret(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return "****"
	}
	return "****" + s[len(s)-4:]
}

// requireJSONBody checks Content-Type and decodes JSON. Returns false if rejected.
func requireJSONBody(w http.ResponseWriter, r *http.Request, dst interface{}) bool {
	ct := r.Header.Get("Content-Type")
	if ct != "application/json" {
		Error(w, http.StatusUnsupportedMediaType, "INVALID_CONTENT_TYPE",
			"Content-Type must be application/json")
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		Error(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid JSON body")
		return false
	}
	return true
}

// setNoCacheHeaders sets Cache-Control headers to prevent caching of sensitive config data.
func setNoCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

// maskedMasterConfig is a copy of MasterConfig with secrets masked for safe API output.
type maskedMasterConfig struct {
	System   domain.SystemConfig    `json:"system"`
	Channels maskedChannelsConfig   `json:"channels"`
}

type maskedChannelsConfig struct {
	Discord  maskedChannelConfig `json:"discord"`
	WhatsApp maskedChannelConfig `json:"whatsapp"`
}

type maskedChannelConfig struct {
	Enabled   bool   `json:"enabled"`
	Token     string `json:"token,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	StorePath string `json:"store_path,omitempty"`
}

func maskMasterConfig(cfg *domain.MasterConfig) maskedMasterConfig {
	return maskedMasterConfig{
		System: cfg.System,
		Channels: maskedChannelsConfig{
			Discord: maskedChannelConfig{
				Enabled:   cfg.Channels.Discord.Enabled,
				Token:     maskSecret(cfg.Channels.Discord.Token),
				ChannelID: cfg.Channels.Discord.ChannelID,
				StorePath: cfg.Channels.Discord.StorePath,
			},
			WhatsApp: maskedChannelConfig{
				Enabled:   cfg.Channels.WhatsApp.Enabled,
				Token:     maskSecret(cfg.Channels.WhatsApp.Token),
				ChannelID: cfg.Channels.WhatsApp.ChannelID,
				StorePath: cfg.Channels.WhatsApp.StorePath,
			},
		},
	}
}

// GetConfigHandler returns a handler for GET /api/v1/config.
func GetConfigHandler(cfgLoader domain.ConfigLoader, _ domain.KeyManager, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := cfgLoader.LoadMaster()
		if err != nil {
			logger.Error("failed to load master config", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load configuration")
			return
		}
		setNoCacheHeaders(w)
		JSON(w, http.StatusOK, maskMasterConfig(cfg))
	}
}

// putConfigRequest is the request body for PUT /api/v1/config.
// Only fields that should be updatable via API are included.
type putConfigRequest struct {
	System   *systemConfigUpdate   `json:"system,omitempty"`
	Channels *channelsConfigUpdate `json:"channels,omitempty"`
}

type systemConfigUpdate struct {
	LogLevel  string `json:"log_level,omitempty"`
	DataDir   string `json:"data_dir,omitempty"`
}

type channelsConfigUpdate struct {
	Discord  *channelConfigUpdate `json:"discord,omitempty"`
	WhatsApp *channelConfigUpdate `json:"whatsapp,omitempty"`
}

type channelConfigUpdate struct {
	Enabled   *bool  `json:"enabled,omitempty"`
	Token     string `json:"token,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	StorePath string `json:"store_path,omitempty"`
}

// PutConfigHandler returns a handler for PUT /api/v1/config.
func PutConfigHandler(cfgLoader domain.ConfigLoader, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putConfigRequest
		if !requireJSONBody(w, r, &req) {
			return
		}

		cfg, err := cfgLoader.LoadMaster()
		if err != nil {
			logger.Error("failed to load master config", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load configuration")
			return
		}

		// Apply partial updates
		if req.System != nil {
			if req.System.LogLevel != "" {
				cfg.System.LogLevel = req.System.LogLevel
			}
			if req.System.DataDir != "" {
				cfg.System.DataDir = req.System.DataDir
			}
		}
		if req.Channels != nil {
			if req.Channels.Discord != nil {
				applyChannelUpdate(&cfg.Channels.Discord, req.Channels.Discord)
			}
			if req.Channels.WhatsApp != nil {
				applyChannelUpdate(&cfg.Channels.WhatsApp, req.Channels.WhatsApp)
			}
		}

		if err := cfgLoader.SaveMaster(cfg); err != nil {
			logger.Error("failed to save master config", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save configuration")
			return
		}

		setNoCacheHeaders(w)
		JSON(w, http.StatusOK, maskMasterConfig(cfg))
	}
}

func applyChannelUpdate(dst *domain.ChannelConfig, src *channelConfigUpdate) {
	if src.Enabled != nil {
		dst.Enabled = *src.Enabled
	}
	if src.Token != "" {
		dst.Token = src.Token
	}
	if src.ChannelID != "" {
		dst.ChannelID = src.ChannelID
	}
	if src.StorePath != "" {
		dst.StorePath = src.StorePath
	}
}

// maskedProvider is a copy of Provider with secrets masked.
type maskedProvider struct {
	Name       string            `json:"name"`
	Type       string            `json:"type"`
	BaseURL    string            `json:"base_url,omitempty"`
	APIKey     string            `json:"api_key,omitempty"`
	OAuthToken string            `json:"oauth_token,omitempty"`
	Models     map[string]string `json:"models,omitempty"`
}

func maskProvider(p domain.Provider) maskedProvider {
	return maskedProvider{
		Name:       p.Name,
		Type:       p.Type,
		BaseURL:    p.BaseURL,
		APIKey:     maskSecret(p.APIKey),
		OAuthToken: maskSecret(p.OAuthToken),
		Models:     p.Models,
	}
}

// GetProvidersHandler returns a handler for GET /api/v1/providers.
func GetProvidersHandler(cfgLoader domain.ConfigLoader, _ domain.KeyManager, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		providers, err := cfgLoader.LoadProviders()
		if err != nil {
			logger.Error("failed to load providers", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load providers")
			return
		}

		masked := make(map[string]maskedProvider, len(providers))
		for name, p := range providers {
			masked[name] = maskProvider(p)
		}

		setNoCacheHeaders(w)
		JSON(w, http.StatusOK, masked)
	}
}

// PutProvidersHandler returns a handler for PUT /api/v1/providers.
func PutProvidersHandler(cfgLoader domain.ConfigLoader, km domain.KeyManager, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var providers map[string]domain.Provider
		if !requireJSONBody(w, r, &providers) {
			return
		}

		// Encrypt secrets before saving if key manager is available and unlocked
		if km != nil && !km.IsLocked() {
			for name, p := range providers {
				if p.APIKey != "" {
					encrypted, err := km.Encrypt(p.APIKey)
					if err != nil {
						logger.Error("failed to encrypt API key", "provider", name, "error", err)
						Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to encrypt provider secrets")
						return
					}
					p.APIKey = encrypted
				}
				if p.OAuthToken != "" {
					encrypted, err := km.Encrypt(p.OAuthToken)
					if err != nil {
						logger.Error("failed to encrypt OAuth token", "provider", name, "error", err)
						Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to encrypt provider secrets")
						return
					}
					p.OAuthToken = encrypted
				}
				providers[name] = p
			}
		}

		if err := cfgLoader.SaveProviders(providers); err != nil {
			logger.Error("failed to save providers", "error", err)
			Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save providers")
			return
		}

		// Return masked version
		masked := make(map[string]maskedProvider, len(providers))
		for name, p := range providers {
			masked[name] = maskProvider(p)
		}

		setNoCacheHeaders(w)
		JSON(w, http.StatusOK, masked)
	}
}
