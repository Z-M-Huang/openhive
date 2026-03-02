package config

import "github.com/Z-M-Huang/openhive/internal/domain"

// DefaultMasterConfig returns a MasterConfig with compiled default values.
func DefaultMasterConfig() *domain.MasterConfig {
	return &domain.MasterConfig{
		System: domain.SystemConfig{
			ListenAddress: "127.0.0.1:8080",
			DataDir:       "data",
			WorkspaceRoot: "/openhive/workspace",
			LogLevel:      "info",
			LogArchive: domain.ArchiveConfig{
				Enabled:    true,
				MaxEntries: 100000,
				KeepCopies: 5,
				ArchiveDir: "data/archives",
			},
		},
		Assistant: domain.AssistantConfig{
			Name:           "OpenHive Assistant",
			AID:            "aid-main-001",
			Provider:       "default",
			ModelTier:      "sonnet",
			MaxTurns:       50,
			TimeoutMinutes: 10,
		},
		Channels: domain.ChannelsConfig{
			Discord:  domain.ChannelConfig{Enabled: false},
			WhatsApp: domain.ChannelConfig{Enabled: false},
		},
	}
}
