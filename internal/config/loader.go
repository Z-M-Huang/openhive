package config

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	defaultDebounce = 200 * time.Millisecond
	encTokenPrefix  = "enc:"
)

// Loader implements the domain.ConfigLoader interface.
type Loader struct {
	dataDir    string // global config: openhive.yaml, providers.yaml
	teamsDir   string // team definitions: teams/<slug>/team.yaml, agents/, skills/
	masterCfg  *domain.MasterConfig
	masterMu   sync.RWMutex
	watcher    *FileWatcher
	keyManager domain.KeyManager
}

// NewLoader creates a new config Loader.
//   - dataDir: global config files (openhive.yaml, providers.yaml)
//   - teamsDir: team definitions (teams/<slug>/). If empty, defaults to dataDir.
func NewLoader(dataDir string, teamsDir string) (*Loader, error) {
	if dataDir == "" {
		dataDir = "data"
	}
	if teamsDir == "" {
		teamsDir = dataDir
	}
	return &Loader{
		dataDir:  dataDir,
		teamsDir: teamsDir,
	}, nil
}

// SetKeyManager attaches a KeyManager for auto-encryption of channel tokens.
// Must be called before LoadMaster for auto-encryption to take effect.
func (l *Loader) SetKeyManager(km domain.KeyManager) {
	l.keyManager = km
}

// LoadMaster reads and parses the master config from openhive.yaml.
// If a KeyManager is set and unlocked, plaintext channel tokens are encrypted
// and written back to disk automatically.
func (l *Loader) LoadMaster() (*domain.MasterConfig, error) {
	path := filepath.Join(l.dataDir, "openhive.yaml")
	cfg, err := LoadMasterFromFile(path)
	if err != nil {
		return nil, err
	}

	// Auto-encrypt plaintext channel tokens when the key manager is available.
	if l.keyManager != nil && !l.keyManager.IsLocked() {
		changed := false
		if cfg.Channels.Discord.Token != "" && !strings.HasPrefix(cfg.Channels.Discord.Token, encTokenPrefix) {
			encrypted, encErr := l.keyManager.Encrypt(cfg.Channels.Discord.Token)
			if encErr != nil {
				slog.Warn("failed to encrypt discord token", "error", encErr)
			} else {
				cfg.Channels.Discord.Token = encrypted
				changed = true
			}
		}
		if cfg.Channels.WhatsApp.Token != "" && !strings.HasPrefix(cfg.Channels.WhatsApp.Token, encTokenPrefix) {
			encrypted, encErr := l.keyManager.Encrypt(cfg.Channels.WhatsApp.Token)
			if encErr != nil {
				slog.Warn("failed to encrypt whatsapp token", "error", encErr)
			} else {
				cfg.Channels.WhatsApp.Token = encrypted
				changed = true
			}
		}
		if changed {
			if saveErr := SaveMasterToFile(path, cfg); saveErr != nil {
				slog.Warn("failed to persist encrypted tokens", "error", saveErr)
			}
		}
	} else if l.keyManager != nil && l.keyManager.IsLocked() {
		// Key manager present but locked: skip encryption, log per-channel warnings for any
		// plaintext tokens. These are STARTUP warnings — the tokens are functional but unencrypted.
		if cfg.Channels.Discord.Token != "" && !strings.HasPrefix(cfg.Channels.Discord.Token, encTokenPrefix) {
			slog.Warn("STARTUP WARNING: discord channel token is stored in plaintext; "+
				"unlock the key manager to encrypt it at rest",
				"channel", "discord",
				"action_required", "POST /api/v1/auth/unlock",
			)
		}
		if cfg.Channels.WhatsApp.Token != "" && !strings.HasPrefix(cfg.Channels.WhatsApp.Token, encTokenPrefix) {
			slog.Warn("STARTUP WARNING: whatsapp channel token is stored in plaintext; "+
				"unlock the key manager to encrypt it at rest",
				"channel", "whatsapp",
				"action_required", "POST /api/v1/auth/unlock",
			)
		}
	}

	l.masterMu.Lock()
	l.masterCfg = cfg
	l.masterMu.Unlock()

	return cfg, nil
}

// DecryptChannelTokens returns a copy of the ChannelsConfig with all enc:-prefixed
// tokens decrypted for runtime use. If the key manager is nil or locked, tokens
// are returned as-is (callers must not use enc:-prefixed values as real credentials).
func (l *Loader) DecryptChannelTokens(channels domain.ChannelsConfig) (domain.ChannelsConfig, error) {
	result := channels
	if l.keyManager == nil || l.keyManager.IsLocked() {
		return result, nil
	}
	if strings.HasPrefix(result.Discord.Token, encTokenPrefix) {
		plain, err := l.keyManager.Decrypt(result.Discord.Token)
		if err != nil {
			return result, fmt.Errorf("failed to decrypt discord token: %w", err)
		}
		result.Discord.Token = plain
	}
	if strings.HasPrefix(result.WhatsApp.Token, encTokenPrefix) {
		plain, err := l.keyManager.Decrypt(result.WhatsApp.Token)
		if err != nil {
			return result, fmt.Errorf("failed to decrypt whatsapp token: %w", err)
		}
		result.WhatsApp.Token = plain
	}
	return result, nil
}

// SaveMaster writes the master config to openhive.yaml atomically.
func (l *Loader) SaveMaster(cfg *domain.MasterConfig) error {
	if err := ValidateMasterConfig(cfg); err != nil {
		return err
	}

	path := filepath.Join(l.dataDir, "openhive.yaml")
	if err := SaveMasterToFile(path, cfg); err != nil {
		return err
	}

	l.masterMu.Lock()
	l.masterCfg = cfg
	l.masterMu.Unlock()

	return nil
}

// GetMaster returns the currently loaded master config.
func (l *Loader) GetMaster() *domain.MasterConfig {
	l.masterMu.RLock()
	defer l.masterMu.RUnlock()
	return l.masterCfg
}

// WatchMaster watches openhive.yaml for changes and calls the callback
// with the new config after a 200ms debounce period.
func (l *Loader) WatchMaster(callback func(*domain.MasterConfig)) error {
	if l.watcher == nil {
		w, err := NewFileWatcher(defaultDebounce)
		if err != nil {
			return fmt.Errorf("failed to create file watcher: %w", err)
		}
		l.watcher = w
	}

	path := filepath.Join(l.dataDir, "openhive.yaml")
	return l.watcher.Watch(path, func() {
		cfg, err := LoadMasterFromFile(path)
		if err != nil {
			slog.Error("failed to reload master config", "error", err)
			return
		}

		l.masterMu.Lock()
		l.masterCfg = cfg
		l.masterMu.Unlock()

		callback(cfg)
	})
}

// LoadProviders reads and parses providers.yaml.
func (l *Loader) LoadProviders() (map[string]domain.Provider, error) {
	path := filepath.Join(l.dataDir, "providers.yaml")
	return LoadProvidersFromFile(path)
}

// SaveProviders writes providers.yaml atomically.
func (l *Loader) SaveProviders(providers map[string]domain.Provider) error {
	path := filepath.Join(l.dataDir, "providers.yaml")
	return SaveProvidersToFile(path, providers)
}

// WatchProviders watches providers.yaml for changes.
func (l *Loader) WatchProviders(callback func(map[string]domain.Provider)) error {
	if l.watcher == nil {
		w, err := NewFileWatcher(defaultDebounce)
		if err != nil {
			return fmt.Errorf("failed to create file watcher: %w", err)
		}
		l.watcher = w
	}

	path := filepath.Join(l.dataDir, "providers.yaml")
	return l.watcher.Watch(path, func() {
		providers, err := LoadProvidersFromFile(path)
		if err != nil {
			slog.Error("failed to reload providers config", "error", err)
			return
		}
		callback(providers)
	})
}

// LoadTeam reads and parses a team config from <teamsDir>/teams/<slug>/team.yaml.
func (l *Loader) LoadTeam(slug string) (*domain.Team, error) {
	teamDir, err := ValidateTeamPath(l.teamsDir, slug)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(teamDir, "team.yaml")
	return LoadTeamFromFile(path, slug)
}

// SaveTeam writes a team config atomically.
func (l *Loader) SaveTeam(slug string, team *domain.Team) error {
	teamDir, err := ValidateTeamPath(l.teamsDir, slug)
	if err != nil {
		return err
	}
	path := filepath.Join(teamDir, "team.yaml")
	return SaveTeamToFile(path, team)
}

// CreateTeamDir creates the directory structure for a new team.
func (l *Loader) CreateTeamDir(slug string) error {
	return CreateTeamDirectory(l.teamsDir, slug)
}

// DeleteTeamDir removes a team directory.
func (l *Loader) DeleteTeamDir(slug string) error {
	teamDir, err := ValidateTeamPath(l.teamsDir, slug)
	if err != nil {
		return err
	}
	return os.RemoveAll(teamDir)
}

// ListTeams returns all team slugs found in <teamsDir>/teams/.
func (l *Loader) ListTeams() ([]string, error) {
	teamsDir := filepath.Join(l.teamsDir, "teams")
	entries, err := os.ReadDir(teamsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to list teams: %w", err)
	}

	var slugs []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// Validate each directory entry as a slug before using it.
		// This filters out entries with invalid names (e.g., symlinks with
		// suspicious names, directories with uppercase, etc.).
		if err := domain.ValidateSlug(entry.Name()); err != nil {
			continue
		}
		teamFile := filepath.Join(teamsDir, entry.Name(), "team.yaml")
		if _, err := os.Lstat(teamFile); err == nil {
			slugs = append(slugs, entry.Name())
		}
	}
	return slugs, nil
}

// WatchTeam watches a team's config file for changes.
func (l *Loader) WatchTeam(slug string, callback func(*domain.Team)) error {
	if l.watcher == nil {
		w, err := NewFileWatcher(defaultDebounce)
		if err != nil {
			return fmt.Errorf("failed to create file watcher: %w", err)
		}
		l.watcher = w
	}

	path := filepath.Join(l.teamsDir, "teams", slug, "team.yaml")
	return l.watcher.Watch(path, func() {
		team, err := LoadTeamFromFile(path, slug)
		if err != nil {
			slog.Error("failed to reload team config", "slug", slug, "error", err)
			return
		}
		callback(team)
	})
}

// StopWatching stops all file watchers.
func (l *Loader) StopWatching() {
	if l.watcher != nil {
		l.watcher.Stop()
	}
}
