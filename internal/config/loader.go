package config

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	defaultDebounce = 200 * time.Millisecond
)

// Loader implements the domain.ConfigLoader interface.
type Loader struct {
	dataDir     string
	masterCfg   *domain.MasterConfig
	masterMu    sync.RWMutex
	watcher     *FileWatcher
}

// NewLoader creates a new config Loader for the given data directory.
func NewLoader(dataDir string) (*Loader, error) {
	if dataDir == "" {
		dataDir = "data"
	}
	return &Loader{
		dataDir: dataDir,
	}, nil
}

// LoadMaster reads and parses the master config from openhive.yaml.
func (l *Loader) LoadMaster() (*domain.MasterConfig, error) {
	path := filepath.Join(l.dataDir, "openhive.yaml")
	cfg, err := LoadMasterFromFile(path)
	if err != nil {
		return nil, err
	}

	l.masterMu.Lock()
	l.masterCfg = cfg
	l.masterMu.Unlock()

	return cfg, nil
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

// LoadTeam reads and parses a team config from data/teams/<slug>/team.yaml.
func (l *Loader) LoadTeam(slug string) (*domain.Team, error) {
	teamDir, err := ValidateTeamPath(l.dataDir, slug)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(teamDir, "team.yaml")
	return LoadTeamFromFile(path, slug)
}

// SaveTeam writes a team config atomically.
func (l *Loader) SaveTeam(slug string, team *domain.Team) error {
	teamDir, err := ValidateTeamPath(l.dataDir, slug)
	if err != nil {
		return err
	}
	path := filepath.Join(teamDir, "team.yaml")
	return SaveTeamToFile(path, team)
}

// CreateTeamDir creates the directory structure for a new team.
func (l *Loader) CreateTeamDir(slug string) error {
	return CreateTeamDirectory(l.dataDir, slug)
}

// DeleteTeamDir removes a team directory.
func (l *Loader) DeleteTeamDir(slug string) error {
	teamDir, err := ValidateTeamPath(l.dataDir, slug)
	if err != nil {
		return err
	}
	return os.RemoveAll(teamDir)
}

// ListTeams returns all team slugs found in data/teams/.
func (l *Loader) ListTeams() ([]string, error) {
	teamsDir := filepath.Join(l.dataDir, "teams")
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

	path := filepath.Join(l.dataDir, "teams", slug, "team.yaml")
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
